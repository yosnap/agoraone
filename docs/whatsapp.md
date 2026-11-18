# WhatsApp (1.7)

AgoraOne lee los chats de WhatsApp del número del usuario a través de [Zernio](https://zernio.com), un servicio
sobre la WhatsApp Cloud API de Meta. El número sigue funcionando en la app WhatsApp Business del móvil (modo
«coexistence»). Decisión del usuario en `AGENTS.md` (18/11/2026).

## Conexión
1. El número se conecta en el panel de Zernio: «Connect WhatsApp» › «Use my own number» › «I chat from the
   WhatsApp Business app», y se escanea el QR desde la app del móvil (WhatsApp Business 2.24.17 o superior).
2. Si Meta marca el número como «No cumple los requisitos», suele estar ya conectado a otro proveedor: hay que
   desconectarlo en el móvil (Ajustes › Cuenta › Plataforma para empresas › Desconectar) y repetir el alta.
3. La clave de API de Zernio (empieza por `sk_`) se pega en **Ajustes › WhatsApp** y se guarda en el Llavero.
   «Probar» dice cuántas cuentas de WhatsApp ve Zernio.

Meta corta la conexión si la app del móvil no se abre en 14 días.

## Lectura
- Solo lectura, por sondeo cada 5 minutos y con «Leer ahora»; nada de webhooks ni puertos abiertos.
- Cada lectura dura como mucho unos 40 s y va a menos de 60 peticiones por minuto; lo que falte, en la siguiente.
  Solo se piden los mensajes de las conversaciones que han cambiado.
- La primera lectura trae lo de los últimos «Días hacia atrás» (60 por defecto); Zernio guarda hasta seis meses
  de historial.
- Se guardan texto, dirección, remitente y fecha. De los adjuntos, solo el tipo; nunca su enlace. Lo que Meta no
  entrega llega como «mensaje no disponible».
- AgoraOne nunca marca nada como leído ni usa el indicador de «escribiendo» (en WhatsApp lo marca como leído).
- **Los grupos no llegan**: Meta no los pasa a la API en coexistence. Tampoco los mensajes temporales ni los de
  ver una vez.
- Cada cuenta tiene ámbito, confidencialidad (normal, solo en este Mac, privado) y días hacia atrás, como el
  correo. Una lectura nunca cambia la confidencialidad.
- El módulo «WhatsApp» se apaga en Ajustes › Módulos; entonces no hay lectura ni peticiones a Zernio.

## Pendiente
Clasificar los mensajes, tarjetas en la Bandeja, responder con vista previa y Watson: ver el plan
`plans/261118-0155-whatsapp-zernio-e-instinct/plan.md`.

Código: `core/agora_core/zernio.py`, `chat_sync.py`, `routes_chat.py`, migración `0030_chat.sql`,
`src/settings/settings-whatsapp.tsx`. Pruebas: `core/tests/test_zernio.py`, `core/tests/test_chat_sync.py`.
