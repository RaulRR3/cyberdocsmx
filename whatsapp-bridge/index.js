require('dotenv').config();

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── Configuración ─────────────────────────────────────────────────────────────
const GA_URL   = process.env.GREENAPI_URL;
const GA_ID    = process.env.GREENAPI_INSTANCE;
const GA_TOKEN = process.env.GREENAPI_TOKEN;
const SB_URL   = (process.env.SUPABASE_URL || 'https://hlqjcjnbtrivxbijcyvv.supabase.co').trim();
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API   = `https://api.telegram.org/bot${TG_TOKEN}`;

// Chat ID del proveedor (Raul) — recibe notificaciones de pedidos automáticos
const RAUL_CHAT_ID = process.env.RAUL_CHAT_ID;

const GRUPO_ACTAS   = process.env.WHATSAPP_GROUP_ID_1;
const GRUPO_ACTAS_2 = process.env.WHATSAPP_GROUP_ID_2;

// ── Pedidos en espera: CURP → datos del pedido ────────────────────────────────
const pendientes = new Map();

// ── Detectar tipo de acta por nombre del servicio ─────────────────────────────
function detectarTipoActa(nombre) {
  const n = (nombre || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (n.includes('matrimonio')) return 'matrimonio';
  if (n.includes('defuncion'))  return 'defuncion';
  if (n.includes('divorcio'))   return 'divorcio';
  if (n.includes('nacimiento') || n.includes('acta')) return 'nacimiento';
  return null;
}

// ── Formatear mensaje para el bot Nat según tipo de acta ──────────────────────
function formatearMensajeNat(tipoActa, curp) {
  if (tipoActa === 'matrimonio') return `MATRIMONIO ${curp}`;
  if (tipoActa === 'defuncion')  return `DEFUNCION ${curp}`;
  if (tipoActa === 'divorcio')   return `DIVORCIO ${curp}`;
  return curp; // nacimiento: solo CURP
}

// ── Extraer CURP de cualquier campo del formulario ────────────────────────────
// Maneja: "CURP", "CURP o Identificador Electrónico", "CURP ESPOSO O ESPOSA", etc.
function extraerCURP(datos) {
  if (!datos || typeof datos !== 'object') return null;
  // 1. Campos directos
  for (const key of ['CURP', 'curp', 'Curp']) {
    if (datos[key] && typeof datos[key] === 'string') {
      return datos[key].toUpperCase().trim();
    }
  }
  // 2. Cualquier campo cuya clave contenga "CURP"
  for (const [k, v] of Object.entries(datos)) {
    if (k.toUpperCase().includes('CURP') && v && typeof v === 'string') {
      const limpio = v.toUpperCase().trim();
      // Validar que tenga formato CURP (18 caracteres alfanuméricos)
      if (/^[A-Z0-9]{16,20}$/.test(limpio)) return limpio;
    }
  }
  return null;
}

// ── Green API: enviar mensaje al grupo ────────────────────────────────────────
async function waEnviar(chatId, mensaje) {
  const r = await fetch(`${GA_URL}/waInstance${GA_ID}/sendMessage/${GA_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: mensaje }),
  });
  const j = await r.json();
  console.log(`[WA →] "${mensaje}" | id: ${j.idMessage || JSON.stringify(j)}`);
  return j;
}

// ── Green API: polling ────────────────────────────────────────────────────────
async function waRecibirNotificacion() {
  const r = await fetch(`${GA_URL}/waInstance${GA_ID}/receiveNotification/${GA_TOKEN}`);
  if (!r.ok) return null;
  return r.json();
}

async function waEliminarNotificacion(receiptId) {
  await fetch(`${GA_URL}/waInstance${GA_ID}/deleteNotification/${GA_TOKEN}/${receiptId}`, {
    method: 'DELETE',
  });
}

async function waDescargar(downloadUrl) {
  const r = await fetch(downloadUrl);
  if (!r.ok) throw new Error(`Error descargando PDF: HTTP ${r.status}`);
  // Compatibilidad con diferentes versiones de fetch (node-fetch vs nativo)
  return typeof r.buffer === 'function' ? r.buffer() : Buffer.from(await r.arrayBuffer());
}

// ── Telegram: enviar documento (con reply opcional) ───────────────────────────
async function tgEnviarDoc(chatId, buffer, filename, caption, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename, contentType: 'application/pdf' });
  if (caption) form.append('caption', caption);
  // reply_to_message_id permite que el bot "responda" al mensaje del pedido
  // con el PDF, lo que el bot existente interpreta como entrega completada
  if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));

  const r = await fetch(`${TG_API}/sendDocument`, {
    method: 'POST', body: form, headers: form.getHeaders(),
  });
  const j = await r.json();
  if (!j.ok) console.error('[TG ✗] sendDocument:', JSON.stringify(j));
  else console.log(`[TG ✓] PDF enviado a chat ${chatId}${replyToMessageId ? ` (reply a ${replyToMessageId})` : ''}`);
  return j;
}

async function tgEnviarTexto(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── Supabase ──────────────────────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
};

async function sbGet(tabla, filtro) {
  const r = await fetch(`${SB_URL}/rest/v1/${tabla}?${filtro}`, { headers: SB_HEADERS });
  const data = await r.json();
  if (!r.ok) throw new Error(`Error en SB GET ${tabla}: ${data.message || r.statusText}`);
  return data;
}

async function sbPatch(tabla, filtro, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${tabla}?${filtro}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error(`[SB ✗] PATCH ${tabla} (${r.status}):`, txt);
  } else {
    const rows = JSON.parse(txt || '[]');
    if (rows.length === 0) console.warn(`[SB ⚠] PATCH ${tabla}: sin filas actualizadas — filtro: ${filtro}`);
    else console.log(`[SB ✓] PATCH ${tabla}: ${rows.length} fila(s) | estado → ${rows[0]?.estado}`);
  }
}

async function sbPost(tabla, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${tabla}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!r.ok) console.error(`[SB ✗] POST ${tabla}:`, r.status, await r.text());
  else console.log(`[SB ✓] ${tabla} insertado`);
}

// Sube el PDF al bucket archivos/entregas y registra en archivos_entrega
async function sbRechazar(orderId, motivo) {
  await sbPatch('pedidos', `id=eq.${orderId}`, {
    estado: 'refunded',
    nota_entrega: `RECHAZADO: ${motivo}`,
  });
}

async function sbEntregarArchivo(orderId, filename, buffer) {
  // 1. Subir a Storage: bucket archivos, carpeta entregas
  const storagePath = `entregas/${filename}`;
  const uploadRes = await fetch(`${SB_URL}/storage/v1/object/archivos/${storagePath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Storage upload error: ${uploadRes.status} ${err}`);
  }
  const publicUrl = `${SB_URL}/storage/v1/object/public/archivos/${storagePath}`;
  console.log(`[SB ✓] PDF subido: ${publicUrl}`);

  // 2. Insertar en tabla archivos_entrega
  await sbPost('archivos_entrega', { pedido_id: orderId, url: publicUrl, nombre: filename });

  // 3. Marcar pedido como completado con URL en nota_entrega
  //    renderDeliveryNote() extrae URLs del texto y muestra botón "Descargar archivo"
  await sbPatch('pedidos', `id=eq.${orderId}`, {
    estado: 'completed',
    nota_entrega: `Entregado automáticamente vía bot WhatsApp\n${publicUrl}`,
  });

  return publicUrl;
}

// ── Polling activo del grupo 2 (las notificaciones de ese grupo no llegan a la cola) ──
async function verificarRespuestaGrupo2(curp, pedido) {
  const enviadoEn = Date.now();
  const maxEspera = 90000; // 90 segundos máximo de espera
  const intervalo = 6000;  // revisar cada 6 segundos

  console.log(`[G2 POLL] Esperando respuesta de Actas Raul para CURP: ${curp}`);

  while (Date.now() - enviadoEn < maxEspera) {
    await new Promise(r => setTimeout(r, intervalo));
    try {
      const resp = await fetch(`${GA_URL}/waInstance${GA_ID}/getChatHistory/${GA_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: GRUPO_ACTAS_2, count: 10 })
      });
      if (!resp.ok) continue;
      const mensajes = await resp.json();

      console.log(`[G2 POLL] ${(mensajes||[]).length} mensajes en historial de Actas Raul`);

      const ahoraMs = Date.now();
      for (const msg of (mensajes || [])) {
        if (msg.type !== 'incoming') continue; // solo mensajes del bot
        const tiempoMsg = (msg.timestamp || 0) * 1000;
        // Aceptar mensajes de los últimos 3 minutos (por desfase de reloj entre servidores)
        if (tiempoMsg < ahoraMs - 180000) continue;

        // PDF → completar pedido
        if (msg.typeMessage === 'documentMessage') {
          const fileName    = msg.fileMessageData?.fileName || '';
          const downloadUrl = msg.fileMessageData?.downloadUrl || '';
          if (fileName.toUpperCase().includes(curp) && downloadUrl) {
            console.log(`[G2 ✓] PDF encontrado en Actas Raul: ${fileName}`);
            const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
            const pdfBuffer = await waDescargar(downloadUrl);
            await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);
            await tgEnviarTexto(RAUL_CHAT_ID,
              `✅ Pedido <b>${pedido.orderId}</b> completado por Actas Raul\n📄 ${fileName}\n⏱ ${tiempoSeg}s`
            );
            return;
          }
        }

        // "Ya fue entregada" en grupo 2 → atención manual
        // En getChatHistory el texto viene en msg.textMessage o msg.extendedTextMessage.text
        const texto = (msg.textMessage || msg.extendedTextMessage?.text || '').trim();
        if (texto.includes('Esta acta ya fue entregada') && texto.toUpperCase().includes(curp)) {
          console.log(`[G2] Actas Raul también dice "ya entregada" → atención manual`);
          await sbPatch('pedidos', `id=eq.${pedido.orderId}`, {
            nota_entrega: `⚠️ REQUIERE ATENCIÓN MANUAL: ambos grupos indicaron que el acta ya fue entregada. CURP: ${curp}`
          });
          await tgEnviarTexto(RAUL_CHAT_ID,
            `⚠️ <b>ATENCIÓN MANUAL REQUERIDA</b>\n` +
            `📦 Pedido: <b>${pedido.orderId}</b>\n` +
            `🔑 CURP: ${curp}\n\n` +
            `Ambos grupos (Pachinko y Actas Raul) indicaron que esta acta ya fue entregada. Necesitas sacarla manualmente.`
          );
          if (pedido.telegramChatId) {
            await tgEnviarTexto(pedido.telegramChatId,
              `⏳ Tu pedido está siendo revisado. En breve recibirás tu documento.`
            );
          }
          return;
        }
      }
    } catch(e) {
      console.error('[G2 POLL ✗]', e.message);
    }
  }

  // Timeout sin respuesta
  console.warn(`[G2 TIMEOUT] Sin respuesta de Actas Raul en 90s para ${curp}`);
  await tgEnviarTexto(RAUL_CHAT_ID,
    `⚠️ <b>ATENCIÓN MANUAL REQUERIDA</b> (timeout)\n` +
    `📦 Pedido: <b>${pedido.orderId}</b>\n` +
    `🔑 CURP: ${curp}\n\n` +
    `No se recibió respuesta de Actas Raul en 90 segundos. Verifica el grupo manualmente.`
  );
}

// ── Procesar notificación de Green API ────────────────────────────────────────
async function procesarNotificacion(notif) {
  const body    = notif.body;
  const typeWH  = body?.typeWebhook;
  const msgData = body?.messageData;
  const sender  = body?.senderData;

  if (typeWH !== 'incomingMessageReceived' || !msgData || !sender) return;

  const chatId = sender.chatId || '';
  // Log ALL incoming messages to diagnose group 2 detection
  console.log(`[POLL ALL] chatId: ${chatId} | tipo: ${msgData.typeMessage} | esperado G1: ${GRUPO_ACTAS} | esperado G2: ${GRUPO_ACTAS_2}`);

  if (chatId !== GRUPO_ACTAS && chatId !== GRUPO_ACTAS_2) return;
  const esGrupo2 = chatId === GRUPO_ACTAS_2;

  const tipoMsg = msgData.typeMessage || '';
  console.log(`[POLL] grupo${esGrupo2 ? ' 2 (Raul)' : ' 1 (Pachinko)'} | tipo: ${tipoMsg}`);

  // ── PDF recibido ──────────────────────────────────────────────────────────
  if (tipoMsg === 'documentMessage') {
    const fd          = msgData.fileMessageData || {};
    const fileName    = (fd.fileName    || '').trim();
    const downloadUrl = (fd.downloadUrl || '').trim();
    if (!fileName.toLowerCase().endsWith('.pdf') || !downloadUrl) return;

    console.log(`[POLL] PDF: "${fileName}"`);

    // Buscar pedido pendiente por CURP en el nombre del archivo (clave: CURP_tipo)
    let clave = null, pedido = null;
    const fileNameUp = fileName.toUpperCase().replace('.PDF', '');
    for (const [k, v] of pendientes.entries()) {
      if (fileNameUp.includes(v.curp || k.split('_')[0])) {
        clave = k; pedido = v; break;
      }
    }
    if (!pedido) { console.log(`[POLL] Sin pedido pendiente para "${fileName}"`); return; }
    pendientes.delete(clave);

    const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
    console.log(`[POLL ✓] ${clave} → pedido ${pedido.orderId} (${tiempoSeg}s)`);

    try {
      const pdfBuffer = await waDescargar(downloadUrl);
      console.log(`[✓] Descargado: ${(pdfBuffer.length / 1024).toFixed(0)} KB`);

      // 1. Subir PDF a Supabase Storage (archivos/entregas) + registrar en archivos_entrega
      //    + marcar pedido como completed → dispara pedidos-update-notify → notifica al cliente
      const publicUrl = await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);

      // 2. Notificar a Raul que se completó automáticamente
      await tgEnviarTexto(RAUL_CHAT_ID,
        `✅ Pedido completado automáticamente\n` +
        `📄 ${fileName}\n` +
        `⏱ ${tiempoSeg}s\n` +
        `🔗 ${publicUrl}`
      );
    } catch (e) {
      console.error(`[✗] Error procesando ${pedido.orderId}:`, e.message);
      await tgEnviarTexto(RAUL_CHAT_ID, `⚠️ Error en pedido automático <b>${pedido.orderId}</b>: ${e.message}`);
    }
    return;
  }

  // ── Rechazo de Nat: "No hay registros disponibles" o "Esta acta ya fue entregada" ──
  if (tipoMsg === 'extendedTextMessage' || tipoMsg === 'textMessage') {
    const texto = (
      msgData.extendedTextMessageData?.text ||
      msgData.textMessageData?.textMessage  || ''
    ).trim();

    const esRechazo   = texto.includes('No hay registros disponibles');
    const esEntregada = texto.includes('Esta acta ya fue entregada');
    if (!esRechazo && !esEntregada) return;

    // Extraer CURP y Tipo del mensaje de Nat
    const matchCurp = texto.match(/Dato:\s*([A-Z0-9]{16,20})/i);
    const matchTipo = texto.match(/Tipo:\s*([A-Z]+)/i);
    if (!matchCurp) return;

    const curp      = matchCurp[1].toUpperCase();
    const tipoNat   = (matchTipo?.[1] || '').toLowerCase(); // nacimiento, defuncion, etc.

    // Buscar por clave compuesta CURP_tipo primero, luego por CURP solo
    let pedido = pendientes.get(`${curp}_${tipoNat}`) || pendientes.get(curp);
    let claveUsada = pendientes.has(`${curp}_${tipoNat}`) ? `${curp}_${tipoNat}` : curp;
    if (!pedido) { console.log(`[POLL] Rechazo Nat para ${curp}_${tipoNat} sin pedido pendiente`); return; }

    console.log(`[POLL] Rechazo Nat → pedido ${pedido.orderId} | CURP: ${curp} | grupo${esGrupo2 ? '2' : '1'}`);

    // ── Si el rechazo es "ya entregada" y viene del grupo 1 → reintentar en grupo 2
    if (esEntregada && !esGrupo2 && !pedido.reintento) {
      console.log(`[RETRY] Acta ya entregada en grupo 1, reintentando en grupo 2 (Actas Raul)...`);
      pedido.reintento = true;
      pedido.timestamp = Date.now();
      pendientes.delete(claveUsada); // sacar del mapa — grupo 2 se maneja por polling activo
      await waEnviar(GRUPO_ACTAS_2, formatearMensajeNat(pedido.tipoActa || 'nacimiento', curp));
      await tgEnviarTexto(RAUL_CHAT_ID,
        `🔄 Reintentando pedido <b>${pedido.orderId}</b> en Actas Raul\n🔑 CURP: ${curp}`
      );
      // Polling activo del grupo 2 (las notificaciones de ese grupo no llegan a la cola)
      verificarRespuestaGrupo2(curp, pedido);
      return;
    }

    // ── Caso: "ya entregada" en AMBOS grupos → requiere atención manual de Raul
    if (esEntregada && pedido.reintento) {
      pendientes.delete(claveUsada);
      // NO rechazar — dejar el pedido en in_progress para que Raul lo atienda
      await sbPatch('pedidos', `id=eq.${pedido.orderId}`, {
        nota_entrega: `⚠️ REQUIERE ATENCIÓN MANUAL: ambos grupos indicaron que el acta ya fue entregada previamente. CURP: ${curp}`
      });
      // Notificar a Raul para que lo resuelva manualmente
      await tgEnviarTexto(RAUL_CHAT_ID,
        `⚠️ <b>ATENCIÓN MANUAL REQUERIDA</b>\n` +
        `📦 Pedido: <b>${pedido.orderId}</b>\n` +
        `🔑 CURP: ${curp}\n\n` +
        `Ambos grupos (Pachinko y Actas Raul) indicaron que esta acta ya fue entregada anteriormente. El pedido sigue activo — necesitas sacarlo manualmente.`
      );
      return;
    }

    // ── Rechazo definitivo: sin registros en RENAPO
    pendientes.delete(claveUsada);

    const motivo = 'CURP sin registros en el sistema. Verificar certificacion en RENAPO';
    const motivoCliente = 'El CURP no tiene registros disponibles. Verifica que este certificado en RENAPO.';

    await sbRechazar(pedido.orderId, motivo);

    await tgEnviarTexto(RAUL_CHAT_ID,
      `❌ Pedido <b>${pedido.orderId}</b> rechazado\n` +
      `🔑 CURP: ${curp}\n` +
      `📋 Motivo: ${motivo}`
    );

    // Notificar al cliente si tiene Telegram
    if (pedido.telegramChatId) {
      await tgEnviarTexto(pedido.telegramChatId,
        `❌ No pudimos obtener tu acta\n📋 CURP: ${curp}\n\n` +
        `${motivoCliente}\n` +
        `Tu pedido ha sido rechazado y se reembolsarán tus créditos.`
      );
    }
  }
}

// ── Loop de polling cada 3 segundos ──────────────────────────────────────────
async function iniciarPolling() {
  console.log('[POLL] Iniciando polling...');
  while (true) {
    try {
      const notif = await waRecibirNotificacion();
      if (notif && notif.receiptId) {
        await procesarNotificacion(notif);
        await waEliminarNotificacion(notif.receiptId);
      }
    } catch (e) {
      console.error('[POLL ✗]', e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── POST /supabase-webhook ────────────────────────────────────────────────────
// Supabase llama esto cuando se inserta un nuevo pedido
// El body incluye: { type: "INSERT", record: { id, cliente_id, servicio_id, datos, ... } }
// IMPORTANTE: el campo "datos" debe incluir "__tg_message_id__" con el ID del mensaje
// de Telegram "Nuevo pedido asignado" para que el bridge pueda responder a él
app.post('/supabase-webhook', async (req, res) => {
  res.json({ ok: true });

  const record = req.body?.record;
  if (!record) return;

  const { id: orderId, cliente_id, servicio_id, estado } = record;
  const datos = typeof record.datos === 'string'
    ? JSON.parse(record.datos) : (record.datos || {});

  // Solo pedidos en proceso
  if (!orderId || !servicio_id || estado !== 'in_progress') return;

  try {
    // Obtener nombre del servicio
    const servicios = await sbGet('servicios', `id=eq.${servicio_id}&select=nombre`);
    const servicio  = servicios?.[0];
    if (!servicio) return;

    const tipoActa = detectarTipoActa(servicio.nombre);
    if (!tipoActa) return; // no es un servicio de actas

    const curp = extraerCURP(datos);
    if (!curp) {
      console.log('[SB WH] Sin CURP en datos:', JSON.stringify(datos));
      return;
    }

    // Telegram message_id del mensaje "Nuevo pedido asignado" (lo guarda el bot en datos)
    const tgMessageId = datos.__tg_message_id__ || null;

    // Obtener telegram_chat_id del cliente
    const usuarios     = await sbGet('usuarios', `id=eq.${cliente_id}&select=telegram_chat_id`);
    const telegramChatId = usuarios?.[0]?.telegram_chat_id || null;

    const mensaje = formatearMensajeNat(tipoActa, curp);

    pendientes.set(`${curp}_${tipoActa}`, {
      orderId, userId: cliente_id, telegramChatId, tgMessageId,
      tipo: `acta_${tipoActa}`, tipoActa, curp,
      timestamp: Date.now(),
    });

    await waEnviar(GRUPO_ACTAS, mensaje);

    // Avisar a Raul que el pedido se procesa automáticamente
    await tgEnviarTexto(RAUL_CHAT_ID,
      `🤖 Procesando automáticamente\n` +
      `📋 ${servicio.nombre}\n` +
      `🔑 CURP: ${curp}\n` +
      `📦 Pedido: ${orderId}`
    );

    console.log(`[SB WH ✓] ${orderId} | ${servicio.nombre} | ${curp} → Nat`);

  } catch (e) {
    console.error('[SB WH ✗]', e.message);
  }
});

// ── POST /process-order ── llamado manual para pruebas ────────────────────────
app.post('/process-order', async (req, res) => {
  const { orderId, tipo, datos, userId, telegramChatId, tgMessageId } = req.body;
  if (!orderId || !tipo || !datos)
    return res.status(400).json({ error: 'Faltan: orderId, tipo, datos' });

  const datosObj = typeof datos === 'string' ? JSON.parse(datos) : datos;
  const tipoActa = tipo.replace('acta_', '');
  const curp     = extraerCURP(datosObj) || (datosObj.CURP || '').toUpperCase().trim();
  if (!curp) return res.status(400).json({ error: 'CURP requerido' });

  const mensaje = formatearMensajeNat(tipoActa, curp);

  pendientes.set(`${curp}_${tipoActa}`, {
    orderId, userId, telegramChatId, tgMessageId: tgMessageId || null,
    tipo, tipoActa, curp, timestamp: Date.now(),
  });

  try {
    await waEnviar(GRUPO_ACTAS, mensaje);
    console.log(`[Manual] Pedido ${orderId} | ${tipoActa} | ${curp}`);
    res.json({ ok: true, clave: curp, mensaje });
  } catch (e) {
    pendientes.delete(curp);
    res.status(500).json({ error: e.message });
  }
});

// ── GET / — health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, status: 'running', pendientes: pendientes.size });
});

// ── Limpiar pedidos expirados cada 15 min ─────────────────────────────────────
setInterval(() => {
  const limite = Date.now() - 30 * 60_000;
  for (const [k, v] of pendientes.entries()) {
    if (v.timestamp < limite) {
      console.warn(`[⏱ exp] Pedido ${v.orderId} (${k}) expiró`);
      pendientes.delete(k);
    }
  }
}, 15 * 60_000);

// ── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Bridge | puerto ${PORT}`);
  console.log(`   Supabase webhook : POST /supabase-webhook`);
  console.log(`   Manual           : POST /process-order`);
  iniciarPolling();
});
