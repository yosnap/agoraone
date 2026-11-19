# Instalación, diagnóstico y módulos (1.6)

Plan: `plans/261115-2032-instalador-modulos/plan.md`. Corresponde a las entradas C-01 y C-02 del backlog.

## Qué tengo instalado

En Ajustes › Instalación aparece cada pieza que AgoraOne puede usar. De cada una se ve si está, qué módulos la
necesitan y cómo conseguirla en este sistema: con Homebrew en macOS, con la orden de Linux o de Windows, o con
la página de descarga.

Las piezas se reparten en tres grupos:

- **Necesarias para algún módulo:** Obsidian, Claude Code, whisper.cpp y su modelo, y ffmpeg.
- **Opcionales:** Hermes, la clave de Anthropic, el audio del sistema, Ollama, LM Studio, la carpeta de música,
  «Oye Watson» y Homebrew.
- **Compatibilidad, para más adelante:** Codex, Gemini CLI, OpenCode y Cursor.

Comprobarlo no cambia nada: solo mira rutas, programas en el PATH y servidores locales
(`core/agora_core/doctor.py`).

## Instalar con permiso

Las piezas instalables tienen un botón **Instalar…**:

- las de Homebrew;
- el modelo de Whisper, que se descarga de Hugging Face a `~/.cache/whisper`.

Antes de instalar, la confirmación enseña la orden exacta o el tamaño de la descarga. Se instala una pieza a la
vez, en segundo plano, con el progreso y las últimas líneas a la vista. Al terminar, el diagnóstico se repite
solo.

Lo que se ejecuta sale siempre de la lista del propio diagnóstico, nunca de una orden enviada desde la
pantalla, y nunca se toca Hermes (`core/agora_core/installer.py`).

## Módulos

En Ajustes › Instalación › Módulos se pueden apagar:

- Correo
- Agenda
- Fiscal
- Trabajos
- Reuniones
- Voz
- Música
- Oficina 3D
- Conectores

Un módulo apagado:

- desaparece de la barra lateral y del Cerebro;
- para su trabajo en segundo plano. Un supervisor arranca o detiene la lectura del correo y sus resúmenes con
  Correo, y Central con Trabajos;
- deja a Watson sin sus herramientas (Bandeja, reglas, agenda, trabajos y clientes).

Sus datos se conservan para cuando se vuelva a encender. Todos están encendidos por defecto
(`core/agora_core/modules.py`).

## Primer arranque

La primera vez aparece una guía en cuatro pantallas: bienvenida, qué tengo instalado, módulos y cómo llamar a
Watson. Se puede saltar, y vale para cualquier navegador porque la marca la guarda el núcleo. Se vuelve a abrir
con «Ver la guía de inicio».

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `GET /doctor` | el diagnóstico |
| `GET/POST /doctor/install` | estado de la instalación e instalar una pieza por su identificador |
| `GET/PUT /modules` | módulos encendidos |
| `GET/PUT /setup/first-run` | si la guía de inicio ya se vio |
