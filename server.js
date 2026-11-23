import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_APP_SECRET,
  BUSINESS_CONFIG,
  ENABLE_TEST_ROUTE,
  PORT = 3000,
} = process.env;

// --- Validar configuración al arrancar (falla rápido y con mensaje claro) ---
const requeridas = {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
};
const faltantes = Object.entries(requeridas)
  .filter(([, valor]) => !valor)
  .map(([nombre]) => nombre);

if (faltantes.length > 0) {
  console.error(`Faltan variables de entorno en .env: ${faltantes.join(", ")}`);
  console.error("Copia .env.example a .env y llénalo.");
  process.exit(1);
}
if (!WHATSAPP_APP_SECRET) {
  console.warn(
    "AVISO: WHATSAPP_APP_SECRET no está definido; no se validará la firma de los webhooks. " +
      "Defínelo antes de poner el bot en producción."
  );
}

const app = express();
// Guardamos el cuerpo crudo: se necesita para validar la firma de Meta.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Cargar el "cerebro" del negocio (lo único que cambia por cliente) ---
const configPath = path.join("config", BUSINESS_CONFIG || "business-context.json");
const negocio = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// --- Memoria de conversación simple en RAM (por número de teléfono) ---
// Limitación conocida: se pierde al reiniciar el servidor. Para producción,
// guardarla en una base de datos (SQLite / Postgres / Firestore).
const historial = new Map();
const MAX_MENSAJES = 10; // cuántos mensajes recuerda el bot por conversación

// --- Deduplicación: Meta reintenta si tardamos en responder ---
const idsProcesados = new Set();
const MAX_IDS = 1000;

function yaProcesado(id) {
  if (idsProcesados.has(id)) return true;
  idsProcesados.add(id);
  if (idsProcesados.size > MAX_IDS) {
    idsProcesados.delete(idsProcesados.values().next().value); // borra el más viejo
  }
  return false;
}

function construirSystemPrompt(negocio) {
  return `Eres el asistente de WhatsApp de "${negocio.nombre_negocio}", un negocio tipo ${negocio.tipo_negocio}.

TONO: ${negocio.tono}

INFORMACIÓN DEL NEGOCIO:
- Horarios: ${negocio.horarios}
- Ubicación: ${negocio.ubicacion}
- Teléfono para hablar con un humano: ${negocio.telefono_humano}

DATOS CLAVE:
${negocio.informacion_clave.map((d) => `- ${d}`).join("\n")}

CATÁLOGO / SERVICIOS:
${negocio.catalogo_o_servicios
  .map((c) => `- ${c.nombre}: ${c.precio} — ${c.descripcion}`)
  .join("\n")}

PREGUNTAS FRECUENTES:
${negocio.preguntas_frecuentes
  .map((p) => `P: ${p.pregunta}\nR: ${p.respuesta}`)
  .join("\n\n")}

REGLAS:
1. Responde SOLO con información de este contexto. Si no sabes algo, dilo con honestidad y ofrece escalar a un humano.
2. Sé breve: estás en WhatsApp, no escribas párrafos largos. Máximo 3-4 líneas por respuesta.
3. Si el cliente quiere hacer un pedido o agendar una cita, recopila los datos necesarios (qué quiere, cuándo, nombre, dirección si aplica) de forma conversacional, un dato a la vez.
4. Debes escalar a un humano (decir explícitamente "te voy a conectar con una persona del equipo, un momento") cuando el caso encaje con cualquiera de estos casos:
${negocio.cuando_escalar_a_humano.map((c) => `   - ${c}`).join("\n")}
5. Nunca inventes precios, disponibilidad o promesas que no estén en este documento.
6. Escribes para WhatsApp: no uses Markdown. Para negritas usa un solo asterisco (*así*) y no uses títulos ni listas con símbolos raros.`;
}

const SYSTEM_PROMPT = construirSystemPrompt(negocio);

// ============================================================
// Seguridad: validar que el webhook realmente viene de Meta
// ============================================================
function firmaValida(req) {
  if (!WHATSAPP_APP_SECRET) return true; // validación desactivada (solo desarrollo)

  const firma = req.get("X-Hub-Signature-256");
  if (!firma || !req.rawBody) return false;

  const esperada =
    "sha256=" +
    crypto.createHmac("sha256", WHATSAPP_APP_SECRET).update(req.rawBody).digest("hex");

  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================
// 1) VERIFICACIÓN DEL WEBHOOK (Meta lo pide una sola vez al configurar)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================
// 2) RECEPCIÓN DE MENSAJES ENTRANTES
// ============================================================
app.post("/webhook", async (req, res) => {
  if (!firmaValida(req)) {
    console.warn("Webhook rechazado: firma inválida.");
    return res.sendStatus(403);
  }

  // Respondemos 200 de inmediato: Meta reintenta si no contestas rápido
  res.sendStatus(200);

  let numeroCliente;
  try {
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje) return; // puede ser un evento de "entregado/leído", no un mensaje nuevo
    if (yaProcesado(mensaje.id)) return; // reintento de Meta: ya lo atendimos

    numeroCliente = mensaje.from; // ej. "5215512345678"
    // México: Meta manda "521..." pero la API de envío espera "52..."
    if (numeroCliente.startsWith("521")) {
      numeroCliente = "52" + numeroCliente.slice(3);
    }

    // Audios, imágenes, etc.: avisamos en vez de ignorar en silencio
    if (mensaje.type !== "text" || !mensaje.text?.body) {
      await enviarMensajeWhatsApp(
        numeroCliente,
        "Por ahora solo puedo leer mensajes de texto 🙂 ¿Me escribes tu duda?"
      );
      return;
    }

    const textoEntrante = mensaje.text.body;
    console.log(`Mensaje de ${numeroCliente}: ${textoEntrante}`);

    const respuesta = await generarRespuesta(numeroCliente, textoEntrante);
    await enviarMensajeWhatsApp(numeroCliente, respuesta);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
    // Aviso al cliente para que no se quede esperando sin respuesta
    if (numeroCliente) {
      try {
        await enviarMensajeWhatsApp(
          numeroCliente,
          "Tuve un problema para responderte 😅 Intenta de nuevo en un momento."
        );
      } catch {
        /* si también falla el aviso, solo queda el log de arriba */
      }
    }
  }
});

// ============================================================
// 3) GENERAR RESPUESTA CON CLAUDE
// ============================================================
async function generarRespuesta(numeroCliente, textoEntrante) {
  if (!historial.has(numeroCliente)) historial.set(numeroCliente, []);
  const conversacion = historial.get(numeroCliente);

  conversacion.push({ role: "user", content: textoEntrante });

  // La API exige que el primer mensaje sea del usuario: si al recortar
  // quedó uno del asistente al inicio, lo descartamos.
  const mensajesRecientes = conversacion.slice(-MAX_MENSAJES);
  while (mensajesRecientes.length > 0 && mensajesRecientes[0].role !== "user") {
    mensajesRecientes.shift();
  }

  let textoRespuesta;
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: mensajesRecientes,
    });

    textoRespuesta = respuesta.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (err) {
    // Si falla, quitamos el mensaje del usuario para no dejar dos "user" seguidos
    conversacion.pop();
    throw err;
  }

  conversacion.push({ role: "assistant", content: textoRespuesta });
  // Evita que la memoria crezca sin límite
  if (conversacion.length > MAX_MENSAJES * 2) {
    conversacion.splice(0, conversacion.length - MAX_MENSAJES);
  }

  return textoRespuesta;
}

// ============================================================
// 4) ENVIAR RESPUESTA POR WHATSAPP CLOUD API
// ============================================================
async function enviarMensajeWhatsApp(numeroDestino, texto) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: numeroDestino,
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error de WhatsApp API:", JSON.stringify(err.response?.data, null, 2));
    throw err;
  }
}

// ============================================================
// RUTA DE PRUEBA (solo si ENABLE_TEST_ROUTE=true): probar el "cerebro" sin WhatsApp
// ============================================================
if (ENABLE_TEST_ROUTE === "true") {
  app.post("/test", async (req, res) => {
    try {
      const { mensaje } = req.body;
      if (!mensaje) {
        return res.status(400).json({ error: "Manda un campo 'mensaje' en el body" });
      }
      const respuesta = await generarRespuesta("usuario-de-prueba", mensaje);
      res.json({ respuesta });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
  console.log("Ruta /test activada (solo para desarrollo).");
}

app.get("/", (_req, res) => {
  res.send(`Agente de ${negocio.nombre_negocio} corriendo correctamente ✅`);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Negocio activo: ${negocio.nombre_negocio}`);
});
