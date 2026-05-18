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
const SB_KEY   = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API   = `https://api.telegram.org/bot${TG_TOKEN}`;

// Chat ID del proveedor (Raul) — recibe notificaciones de pedidos automáticos
const RAUL_CHAT_ID = process.env.RAUL_CHAT_ID;

const GRUPO_ACTAS   = process.env.WHATSAPP_GROUP_ID_1;
const GRUPO_ACTAS_2 = process.env.WHATSAPP_GROUP_ID_2;
const GRUPO_CSF     = process.env.WHATSAPP_GROUP_ID_CSF; // Grupo Nuevo Elaine
const GRUPO_CFE     = process.env.WHATSAPP_GROUP_ID_CFE; // Grupo GPO 074 CFE

// ── Pedidos en espera: CURP → datos del pedido ────────────────────────────────
const pendientes = new Map();

// ── Detectar si el servicio es Constancia de Situación Fiscal ─────────────────
function detectarCSF(nombre) {
  const n = (nombre || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return n.includes('constancia') && n.includes('fiscal') && n.includes('clon');
}

// ── Detectar tipo de acta por nombre del servicio ─────────────────────────────
// ── Detectar si el servicio es Recibo CFE ─────────────────────────────────────
function detectarCFE(nombre) {
  const n = (nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (n.includes('cfe') && (n.includes('recibo') || n.includes('recib'))) ||
         n === 'recibo cfe' || n.includes('recibo de luz');
}

// Extraer número de servicio CFE de los datos del pedido
// Prioridad: campo cuya clave contenga "servicio"; fallback: primer valor de 10-13 dígitos
function extraerNumServicioCFE(datos) {
  if (!datos || typeof datos !== 'object') return null;
  // 1. Buscar por nombre de clave (clave que contenga "servicio")
  for (const key of Object.keys(datos)) {
    if (key.toLowerCase().includes('servicio')) {
      const val = datos[key];
      if (typeof val === 'string') {
        const limpio = val.replace(/\D/g, '').trim();
        if (limpio.length >= 10 && limpio.length <= 13) return limpio;
      }
    }
  }
  // 2. Fallback: cualquier campo con 10-13 dígitos (excluir campos de medidor/otros)
  for (const key of Object.keys(datos)) {
    if (key.startsWith('__')) continue;
    const val = datos[key];
    if (typeof val === 'string') {
      const limpio = val.replace(/\D/g, '').trim();
      if (limpio.length >= 10 && limpio.length <= 13) return limpio;
    }
  }
  return null;
}

function detectarTipoActa(nombre) {
  const n = (nombre || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (n.includes('matrimonio')) return 'matrimonio';
  // 'defunci' cubre tanto 'defuncion' como 'defunción' sin depender del normalize
  if (n.includes('defunci') || n.includes('defuncion')) return 'defuncion';
  if (n.includes('divorcio'))   return 'divorcio';
  // 'acta' va al final para no interceptar "Acta de Defunción" o "Acta de Matrimonio"
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
  if (!chatId) {
    console.error(`[WA ✗] chatId es undefined/null — verifica la variable de entorno del grupo. Mensaje: "${mensaje}"`);
    return { error: 'chatId not set' };
  }
  const r = await fetch(`${GA_URL}/waInstance${GA_ID}/sendMessage/${GA_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: mensaje }),
  });
  const j = await r.json();
  if (j.idMessage) {
    console.log(`[WA ✓] Enviado a ${chatId} | id: ${j.idMessage}`);
  } else {
    console.error(`[WA ✗] Error enviando a ${chatId}: ${JSON.stringify(j)}`);
  }
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

async function sbRechazar(orderId, motivo) {
  // Obtener el pedido para saber cuántos créditos devolver
  const pedidos = await sbGet('pedidos', `id=eq.${orderId}&select=id,cliente_id,creditos`);
  const pedido  = pedidos?.[0];

  await sbPatch('pedidos', `id=eq.${orderId}`, {
    estado: 'refunded',
    completed_at: new Date().toISOString(),
    nota_entrega: `RECHAZADO: ${motivo}`,
  });

  // Devolver créditos al cliente si el pedido tenía costo
  if (pedido?.cliente_id && pedido.creditos > 0) {
    const usuarios = await sbGet('usuarios', `id=eq.${pedido.cliente_id}&select=id,creditos`);
    const usuario  = usuarios?.[0];
    if (usuario) {
      const nuevosCreditos = (usuario.creditos || 0) + pedido.creditos;
      await sbPatch('usuarios', `id=eq.${pedido.cliente_id}`, { creditos: nuevosCreditos });
      // Registrar la transacción de reembolso
      await sbPost('transacciones', {
        usuario_id: pedido.cliente_id,
        tipo: 'refund',
        cantidad: pedido.creditos,
        descripcion: `Reembolso automático — ${motivo}`,
      });
      console.log(`[SB ✓] Reembolso ${pedido.creditos} créditos → usuario ${pedido.cliente_id}`);
    }
  }
}

// Sube el PDF al bucket archivos/entregas y registra en archivos_entrega

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
    completed_at: new Date().toISOString(),
    nota_entrega: `Entregado automáticamente vía bot WhatsApp\n${publicUrl}`,
  });

  return publicUrl;
}

// ── Polling activo del grupo CSF (Elaine) — usa lastIncomingMessages ─────────
async function verificarRespuestaCSF(curp, pedido) {
  const enviadoEn = Date.now();
  const maxEspera = 600000; // 10 minutos
  const intervalo = 6000;
  let esperandoReintento = false;
  let tiempoReintento    = null;
  let intentos           = 0;
  const maxIntentos      = 3;

  console.log(`[CSF POLL] Esperando respuesta de Elaine para CURP: ${curp}`);

  while (Date.now() - enviadoEn < maxEspera) {
    await new Promise(r => setTimeout(r, intervalo));

    // Si estamos esperando para reintentar por interrupcion
    if (esperandoReintento) {
      if (Date.now() >= tiempoReintento) {
        esperandoReintento = false;
        intentos++;
        if (intentos > maxIntentos) break;
        console.log(`[CSF RETRY ${intentos}] Reenviando CURP: ${curp}`);
        pedido.timestamp = Date.now();
        await waEnviar(GRUPO_CSF, curp);
      }
      continue;
    }

    try {
      // lastIncomingMessages devuelve documentMessage del grupo Elaine (getChatHistory no los incluye)
      const resp = await fetch(`${GA_URL}/waInstance${GA_ID}/lastIncomingMessages/${GA_TOKEN}?minutes=12`);
      if (!resp.ok) continue;
      const todos = await resp.json();
      const mensajes = (todos || []).filter(m => m.chatId === GRUPO_CSF);

      console.log(`[CSF POLL] ${mensajes.length} mensajes del grupo Elaine`);

      for (const msg of mensajes) {
        const tiempoMsg = (msg.timestamp || 0) * 1000;
        if (tiempoMsg < pedido.timestamp - 5000) continue; // solo mensajes posteriores al envio

        // PDF recibido — en lastIncomingMessages los campos son directos (no en fileMessageData)
        if (msg.typeMessage === 'documentMessage') {
          const fileName    = msg.fileName    || msg.fileMessageData?.fileName    || '';
          const downloadUrl = msg.downloadUrl || msg.fileMessageData?.downloadUrl || '';
          if (!fileName.toLowerCase().endsWith('.pdf') || !downloadUrl) continue;
          if (!fileName.toUpperCase().includes(curp)) continue;

          console.log(`[CSF POLL ✓] PDF encontrado: ${fileName}`);
          pendientes.delete(`csf_${curp}`);
          const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
          const pdfBuffer = await waDescargar(downloadUrl);
          const publicUrl = await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);
          await tgEnviarTexto(RAUL_CHAT_ID,
            `✅ Constancia Fiscal completada automaticamente\n📄 ${fileName}\n⏱ ${tiempoSeg}s\n🔗 ${publicUrl}`
          );
          return;
        }

        const texto = (
          msg.textMessage ||
          msg.extendedTextMessageData?.text ||
          msg.extendedTextMessage?.text || ''
        ).trim();

        // Interrupcion temporal → reintentar en 3 minutos
        if (texto.includes('interrupci') && !esperandoReintento) {
          console.log(`[CSF] Interrupcion detectada para ${curp}, reintentando en 3 min`);
          esperandoReintento = true;
          tiempoReintento    = Date.now() + 180000;
          await tgEnviarTexto(RAUL_CHAT_ID,
            `⏳ <b>CSF Pedido ${pedido.orderId}</b>\nEl bot tuvo una interrupcion. Reintentando automaticamente en 3 minutos...\n🔑 CURP: ${curp}`
          );
        }

        // Rechazo definitivo
        const esRechazo = texto.toLowerCase().includes('no encontrado') ||
                          texto.toLowerCase().includes('no existe')     ||
                          texto.toLowerCase().includes('no hay registros');
        if (esRechazo) {
          pendientes.delete(`csf_${curp}`);
          await sbRechazar(pedido.orderId, 'CURP sin registros en el SAT.');
          await tgEnviarTexto(RAUL_CHAT_ID,
            `❌ Pedido CSF <b>${pedido.orderId}</b> rechazado\n🔑 CURP: ${curp}\n📋 Sin registros en el SAT`
          );
          if (pedido.telegramChatId) {
            await tgEnviarTexto(pedido.telegramChatId,
              `❌ No pudimos obtener tu Constancia Fiscal\n📋 CURP: ${curp}\n\nVerifica que el CURP sea correcto.\nTus creditos han sido reembolsados automaticamente.`
            );
          }
          return;
        }
      }
    } catch(e) {
      console.error('[CSF POLL ✗]', e.message);
    }
  }

  console.warn(`[CSF TIMEOUT] Sin respuesta de Elaine en 10min para ${curp}`);
  pendientes.delete(`csf_${curp}`);
  await tgEnviarTexto(RAUL_CHAT_ID,
    `⚠️ <b>ATENCION MANUAL REQUERIDA</b> (timeout CSF)\n` +
    `📦 Pedido: <b>${pedido.orderId}</b>\n` +
    `🔑 CURP: ${curp}\n\n` +
    `No se recibio respuesta del grupo Elaine en 10 minutos.`
  );
}

// ── Polling activo del grupo 2 (las notificaciones de ese grupo no llegan a la cola) ──
// ── Polling activo del grupo CFE ──────────────────────────────────────────────
async function verificarRespuestaCFE(numServicio, pedido) {
  const enviadoEn = Date.now();
  const maxEspera = 300000; // 5 minutos
  const intervalo = 6000;

  console.log(`[CFE POLL] Esperando PDF para número de servicio: ${numServicio}`);

  while (Date.now() - enviadoEn < maxEspera) {
    await new Promise(r => setTimeout(r, intervalo));
    try {
      const resp = await fetch(`${GA_URL}/waInstance${GA_ID}/lastIncomingMessages/${GA_TOKEN}?minutes=10`);
      if (!resp.ok) continue;
      const todos = await resp.json();
      const mensajes = (todos || []).filter(m => m.chatId === GRUPO_CFE);

      for (const msg of mensajes) {
        const tiempoMsg = (msg.timestamp || 0) * 1000;
        if (tiempoMsg < pedido.timestamp - 5000) continue;

        if (msg.typeMessage === 'documentMessage') {
          const fileName    = msg.fileName    || msg.fileMessageData?.fileName    || '';
          const downloadUrl = msg.downloadUrl || msg.fileMessageData?.downloadUrl || '';
          if (!fileName.toLowerCase().endsWith('.pdf') || !downloadUrl) continue;
          if (!fileName.includes(numServicio)) continue;

          console.log(`[CFE POLL ✓] PDF encontrado: ${fileName}`);
          pendientes.delete(`cfe_${numServicio}`);
          const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
          const pdfBuffer = await waDescargar(downloadUrl);
          const publicUrl = await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);
          await tgEnviarTexto(RAUL_CHAT_ID,
            `⚡ Recibo CFE completado automáticamente\n📄 ${fileName}\n⏱ ${tiempoSeg}s\n🔗 ${publicUrl}`
          );
          return;
        }
      }
    } catch (e) {
      console.error('[CFE POLL ✗]', e.message);
    }
  }

  // Timeout — notificar a Raul para atención manual
  pendientes.delete(`cfe_${numServicio}`);
  await tgEnviarTexto(RAUL_CHAT_ID,
    `⚡ <b>ATENCIÓN MANUAL REQUERIDA</b> (timeout CFE)\n` +
    `📦 Pedido: <b>${pedido.orderId}</b>\n` +
    `🔢 Número de servicio: ${numServicio}\n\n` +
    `No se recibió el PDF del grupo CFE en 5 minutos.`
  );
}

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
  // Log ALL incoming messages to diagnose group detection
  console.log(`[POLL ALL] chatId: ${chatId} | tipo: ${msgData.typeMessage} | G1: ${GRUPO_ACTAS} | G2: ${GRUPO_ACTAS_2} | CSF: ${GRUPO_CSF}`);

  if (chatId !== GRUPO_ACTAS && chatId !== GRUPO_ACTAS_2 && chatId !== GRUPO_CSF && chatId !== GRUPO_CFE) return;
  const esGrupo2   = chatId === GRUPO_ACTAS_2;
  const esGrupoCSF = chatId === GRUPO_CSF;
  const esGrupoCFE = chatId === GRUPO_CFE;

  const tipoMsg = msgData.typeMessage || '';
  console.log(`[POLL] grupo${esGrupoCSF ? ' CSF (Elaine)' : esGrupo2 ? ' 2 (Raul)' : ' 1 (Pachinko)'} | tipo: ${tipoMsg}`);

  // ── PDF recibido ──────────────────────────────────────────────────────────
  if (tipoMsg === 'documentMessage') {
    const fd          = msgData.fileMessageData || {};
    const fileName    = (fd.fileName    || '').trim();
    const downloadUrl = (fd.downloadUrl || '').trim();
    if (!fileName.toLowerCase().endsWith('.pdf') || !downloadUrl) return;

    console.log(`[POLL] PDF: "${fileName}"`);

    // ── PDF del grupo CFE ─────────────────────────────────────────────────────
    if (esGrupoCFE) {
      const fileNameUp = fileName.toUpperCase().replace('.PDF', '');
      let clave = null, pedido = null;
      for (const [k, v] of pendientes.entries()) {
        if (!k.startsWith('cfe_')) continue;
        if (fileNameUp.includes(v.numServicio || k.replace('cfe_', ''))) { clave = k; pedido = v; break; }
      }
      if (!pedido) {
        for (const [k, v] of pendientes.entries()) {
          if (k.startsWith('cfe_')) { clave = k; pedido = v; break; }
        }
      }
      if (!pedido) { console.log(`[CFE] Sin pedido pendiente para "${fileName}"`); return; }
      pendientes.delete(clave);
      const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
      try {
        const pdfBuffer = await waDescargar(downloadUrl);
        const publicUrl = await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);
        await tgEnviarTexto(RAUL_CHAT_ID,
          `⚡ Recibo CFE completado automáticamente\n📄 ${fileName}\n⏱ ${tiempoSeg}s\n🔗 ${publicUrl}`
        );
      } catch (e) {
        console.error(`[CFE ✗] Error procesando ${pedido.orderId}:`, e.message);
        await tgEnviarTexto(RAUL_CHAT_ID, `⚡ Error en pedido CFE <b>${pedido.orderId}</b>: ${e.message}`);
      }
      return;
    }

    // ── PDF del grupo CSF (Elaine) ─────────────────────────────────────────
    if (esGrupoCSF) {
      const fileNameUp = fileName.toUpperCase().replace('.PDF', '');

      // Buscar pedido CSF por CURP en el nombre del archivo
      let clave = null, pedido = null;
      for (const [k, v] of pendientes.entries()) {
        if (!k.startsWith('csf_')) continue;
        const curpPedido = v.curp || k.replace('csf_', '');
        if (fileNameUp.includes(curpPedido)) { clave = k; pedido = v; break; }
      }
      // Si no hay match por nombre, tomar el primer pedido CSF pendiente
      if (!pedido) {
        for (const [k, v] of pendientes.entries()) {
          if (k.startsWith('csf_')) { clave = k; pedido = v; break; }
        }
      }
      if (!pedido) { console.log(`[CSF] Sin pedido pendiente para "${fileName}"`); return; }
      pendientes.delete(clave);

      const tiempoSeg = ((Date.now() - pedido.timestamp) / 1000).toFixed(1);
      console.log(`[CSF ✓] ${clave} → pedido ${pedido.orderId} (${tiempoSeg}s)`);
      try {
        const pdfBuffer = await waDescargar(downloadUrl);
        const publicUrl = await sbEntregarArchivo(pedido.orderId, fileName, pdfBuffer);
        await tgEnviarTexto(RAUL_CHAT_ID,
          `✅ Constancia Fiscal completada automáticamente\n` +
          `📄 ${fileName}\n` +
          `⏱ ${tiempoSeg}s\n` +
          `🔗 ${publicUrl}`
        );
      } catch (e) {
        console.error(`[CSF ✗] Error procesando ${pedido.orderId}:`, e.message);
        await tgEnviarTexto(RAUL_CHAT_ID, `⚠️ Error en pedido CSF <b>${pedido.orderId}</b>: ${e.message}`);
      }
      return;
    }

    // ── PDF de grupos de Actas ─────────────────────────────────────────────
    // Buscar pedido pendiente por CURP en el nombre del archivo (clave: CURP_tipo)
    let clave = null, pedido = null;
    const fileNameUp = fileName.toUpperCase().replace('.PDF', '');
    for (const [k, v] of pendientes.entries()) {
      if (k.startsWith('csf_')) continue; // ignorar pendientes CSF aquí
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

  // ── Rechazo del bot de Elaine (CSF) ──────────────────────────────────────
  if ((tipoMsg === 'extendedTextMessage' || tipoMsg === 'textMessage') && esGrupoCSF) {
    const texto = (
      msgData.extendedTextMessageData?.text ||
      msgData.textMessageData?.textMessage  || ''
    ).trim();

    // Ajusta este texto según lo que responda el bot cuando no encuentra el RFC/CURP
    const esRechazoCSF = texto.toLowerCase().includes('no encontrado') ||
                         texto.toLowerCase().includes('no existe')     ||
                         texto.toLowerCase().includes('no hay registros');
    if (!esRechazoCSF) return;

    // Intentar extraer CURP del mensaje del bot (formato: 18 chars alfanuméricos)
    const matchCurp = texto.match(/([A-Z]{4}[0-9]{6}[A-Z]{6}[A-Z0-9]{2})/i);
    let clave = null, pedido = null;

    if (matchCurp) {
      const curp = matchCurp[1].toUpperCase();
      clave  = `csf_${curp}`;
      pedido = pendientes.get(clave);
    }
    // Fallback: primer pedido CSF pendiente
    if (!pedido) {
      for (const [k, v] of pendientes.entries()) {
        if (k.startsWith('csf_')) { clave = k; pedido = v; break; }
      }
    }
    if (!pedido) return;

    pendientes.delete(clave);
    const curp = pedido.curp;

    await sbRechazar(pedido.orderId, 'CURP sin registros en el SAT. Verifica que el CURP sea correcto.');
    await tgEnviarTexto(RAUL_CHAT_ID,
      `❌ Pedido CSF <b>${pedido.orderId}</b> rechazado\n🔑 CURP: ${curp}\n📋 Sin registros en el SAT`
    );
    if (pedido.telegramChatId) {
      await tgEnviarTexto(pedido.telegramChatId,
        `❌ No pudimos obtener tu Constancia Fiscal\n📋 CURP: ${curp}\n\n` +
        `Verifica que el CURP sea correcto.\n` +
        `Tus créditos han sido reembolsados automáticamente.`
      );
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
    const esCSF    = !tipoActa && detectarCSF(servicio.nombre);
    const esCFE    = !tipoActa && !esCSF && detectarCFE(servicio.nombre);

    if (!tipoActa && !esCSF && !esCFE) return; // servicio no automatizado

    // ── Recibo CFE ─────────────────────────────────────────────────────────────
    if (esCFE) {
      const numServicio = extraerNumServicioCFE(datos);
      if (!numServicio) { console.log('[SB WH CFE] Sin número de 12 dígitos en datos:', JSON.stringify(datos)); return; }

      const tgMsgId        = datos.__tg_message_id__ || null;
      const usuariosCFE    = await sbGet('usuarios', `id=eq.${cliente_id}&select=telegram_chat_id`);
      const telegramChatId = usuariosCFE?.[0]?.telegram_chat_id || null;

      const clave = `cfe_${numServicio}`;
      pendientes.set(clave, { orderId, userId: cliente_id, telegramChatId, tgMessageId: tgMsgId, tipo: 'cfe', numServicio, timestamp: Date.now() });

      await waEnviar(GRUPO_CFE, numServicio);
      await tgEnviarTexto(RAUL_CHAT_ID,
        `⚡ Procesando Recibo CFE automáticamente\n` +
        `📋 ${servicio.nombre}\n` +
        `🔢 Número: ${numServicio}\n` +
        `📦 Pedido: ${orderId}`
      );
      console.log(`[SB WH ✓] ${orderId} | CFE | ${numServicio} → GPO 074 CFE`);
      verificarRespuestaCFE(numServicio, pendientes.get(clave));
      return;
    }

    const curp = extraerCURP(datos);
    if (!curp) {
      console.log('[SB WH] Sin CURP en datos:', JSON.stringify(datos));
      return;
    }

    // Telegram message_id del mensaje "Nuevo pedido asignado" (lo guarda el bot en datos)
    const tgMessageId = datos.__tg_message_id__ || null;

    // Obtener telegram_chat_id del cliente
    const usuarios       = await sbGet('usuarios', `id=eq.${cliente_id}&select=telegram_chat_id`);
    const telegramChatId = usuarios?.[0]?.telegram_chat_id || null;

    // ── Constancia de Situación Fiscal → Grupo Elaine ─────────────────────
    if (esCSF) {
      pendientes.set(`csf_${curp}`, {
        orderId, userId: cliente_id, telegramChatId, tgMessageId,
        tipo: 'csf', curp, timestamp: Date.now(),
      });

      await waEnviar(GRUPO_CSF, curp);

      await tgEnviarTexto(RAUL_CHAT_ID,
        `🤖 Procesando Constancia Fiscal automáticamente\n` +
        `📋 ${servicio.nombre}\n` +
        `🔑 CURP: ${curp}\n` +
        `📦 Pedido: ${orderId}`
      );
      console.log(`[SB WH ✓] ${orderId} | ${servicio.nombre} | ${curp} → Elaine (CSF)`);
      verificarRespuestaCSF(curp, pendientes.get(`csf_${curp}`));
      return;
    }

    // ── Actas → Grupo Pachinko ─────────────────────────────────────────────
    const mensaje = formatearMensajeNat(tipoActa, curp);

    pendientes.set(`${curp}_${tipoActa}`, {
      orderId, userId: cliente_id, telegramChatId, tgMessageId,
      tipo: `acta_${tipoActa}`, tipoActa, curp,
      timestamp: Date.now(),
    });

    await waEnviar(GRUPO_ACTAS, mensaje);

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
  const curp     = extraerCURP(datosObj) || (datosObj.CURP || '').toUpperCase().trim();
  if (!curp) return res.status(400).json({ error: 'CURP requerido' });

  // ── CSF manual ────────────────────────────────────────────────────────────
  if (tipo === 'csf') {
    const clave = `csf_${curp}`;
    pendientes.set(clave, {
      orderId, userId, telegramChatId, tgMessageId: tgMessageId || null,
      tipo: 'csf', curp, timestamp: Date.now(),
    });
    try {
      await waEnviar(GRUPO_CSF, curp);
      console.log(`[Manual CSF] Pedido ${orderId} | CURP: ${curp}`);
      verificarRespuestaCSF(curp, pendientes.get(clave));
      return res.json({ ok: true, clave, mensaje: curp });
    } catch (e) {
      pendientes.delete(clave);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Actas manual ──────────────────────────────────────────────────────────
  const tipoActa = tipo.replace('acta_', '');
  const mensaje  = formatearMensajeNat(tipoActa, curp);

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
// Reenvía al grupo cada 30 min mientras espera, cancela después de 2 horas.
// Si el pedido ya fue completado manualmente (proveedor subió el acta), NO cancela.
setInterval(async () => {
  const ahora            = Date.now();
  const limiteExpiracion = ahora - 2 * 60 * 60_000;  // 2 horas
  const intervaloReenvio = 30 * 60_000;               // reenviar cada 30 min

  for (const [k, v] of pendientes.entries()) {
    // ── Cancelar si lleva 2 horas sin respuesta ────────────────────────────
    if (v.timestamp < limiteExpiracion) {
      pendientes.delete(k);
      try {
        // Verificar estado actual antes de cancelar — puede que el proveedor
        // ya lo haya entregado manualmente vía Telegram
        const pedidos = await sbGet('pedidos', `id=eq.${v.orderId}&select=id,estado`);
        const pedido  = pedidos?.[0];
        if (pedido && pedido.estado !== 'in_progress') {
          console.log(`[⏱ exp] Pedido ${v.orderId} ya en estado "${pedido.estado}" — removido de pendientes sin cancelar`);
          continue;
        }

        console.warn(`[⏱ exp] Pedido ${v.orderId} (${k}) expiró sin respuesta tras 2 horas — reembolsando`);
        await sbRechazar(v.orderId, 'Sin respuesta del sistema en 2 horas. Intenta de nuevo o contacta soporte.');
        if (v.telegramChatId) {
          await tgEnviarTexto(v.telegramChatId,
            `❌ Tu pedido no recibió respuesta a tiempo.\n` +
            `Tus créditos han sido reembolsados automáticamente.\n` +
            `Puedes intentarlo de nuevo o contactar soporte.`
          );
        }
        await tgEnviarTexto(RAUL_CHAT_ID,
          `⏱ <b>Pedido expirado — reembolso automático</b>\n` +
          `📦 Pedido: <b>${v.orderId}</b>\n` +
          `🔑 Clave: ${k}`
        );
      } catch (e) {
        console.error(`[⏱ exp ✗] Error reembolsando pedido expirado ${v.orderId}:`, e.message);
        await tgEnviarTexto(RAUL_CHAT_ID,
          `⚠️ <b>Error al reembolsar pedido expirado</b>\n` +
          `📦 Pedido: <b>${v.orderId}</b>\n` +
          `Error: ${e.message}\n` +
          `Reembolsa manualmente desde el panel.`
        ).catch(() => {});
      }
      continue;
    }

    // ── Reenviar al grupo si llevan 30 min sin respuesta ──────────────────
    const ultimoEnvio = v.ultimoEnvio || v.timestamp;
    if (ahora - ultimoEnvio >= intervaloReenvio) {
      v.ultimoEnvio = ahora;
      try {
        if (k.startsWith('csf_')) {
          await waEnviar(GRUPO_CSF, v.curp);
        } else if (k.startsWith('cfe_')) {
          await waEnviar(GRUPO_CFE, v.numServicio);
        } else {
          await waEnviar(GRUPO_ACTAS, formatearMensajeNat(v.tipoActa || 'nacimiento', v.curp));
        }
        const minutos = Math.round((ahora - v.timestamp) / 60_000);
        console.log(`[⏱ retry] Pedido ${v.orderId} (${k}) reenviado al grupo tras ${minutos} min sin respuesta`);
        await tgEnviarTexto(RAUL_CHAT_ID,
          `🔄 <b>Reintento automático</b>\n` +
          `📦 Pedido: <b>${v.orderId}</b>\n` +
          `🔑 Clave: ${k}\n` +
          `⏱ Sin respuesta en ${minutos} min — reenviando solicitud al grupo.`
        );
      } catch (e) {
        console.error(`[⏱ retry ✗] Error reenviando ${v.orderId}:`, e.message);
      }
    }
  }
}, 15 * 60_000);

// ── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Bridge | puerto ${PORT}`);
  console.log(`   Supabase webhook : POST /supabase-webhook`);
  console.log(`   Manual           : POST /process-order`);
  console.log(`\n📋 Grupos configurados:`);
  console.log(`   GRUPO_ACTAS   : ${GRUPO_ACTAS   || '❌ NO CONFIGURADO'}`);
  console.log(`   GRUPO_ACTAS_2 : ${GRUPO_ACTAS_2 || '❌ NO CONFIGURADO'}`);
  console.log(`   GRUPO_CSF     : ${GRUPO_CSF     || '❌ NO CONFIGURADO'}`);
  console.log(`   GRUPO_CFE     : ${GRUPO_CFE     || '❌ NO CONFIGURADO'}`);
  console.log(`   RAUL_CHAT_ID  : ${RAUL_CHAT_ID  || '❌ NO CONFIGURADO'}\n`);
  iniciarPolling();
});
