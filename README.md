# RodentBot - Tu Compañero Inteligente en Minecraft

RodentBot es un bot versátil para Minecraft (Java Edition) construido con `mineflayer`. Está diseñado para ayudarte en tus aventuras, automatizar tareas y defenderte de los peligros del mundo.

## ✨ Características Principales

*   **Conexión y Configuración Sencilla:**
    *   Se conecta a tu servidor de Minecraft (configurable).
    *   Carga configuraciones desde un archivo `.env` (prefijo, claves API, IP/puerto, mobs hostiles).
    *   **¡Soporte Multilingüe!** Incluye un extenso diccionario (`blockTranslations.js`) para entender nombres de bloques e ítems en español.

*   **Navegación Inteligente con Pathfinder:**
    *   Sigue jugadores (`!rodent sigueme`).
    *   Se detiene y reanuda el movimiento (`!rodent quedate`, `!rodent reanuda`).
    *   Va a la posición de un jugador o a coordenadas específicas (`!rodent ven`, `!rodent ve`).

*   **Interacción Avanzada con el Mundo:**
    *   **Aplanar Terreno (`!rodent aplana <tamaño>`):** Excava un área para nivelarla.
    *   **Conseguir Bloques (`!rodent consigue <nombre_bloque>`):** Busca, viaja, equipa la herramienta adecuada (incluso usando `/give` si es OP y no la tiene), mina el bloque y regresa.

*   **Gestión de Inventario Completa:**
    *   Muestra el inventario (`!rodent inventario`).
    *   Entrega ítems a jugadores (`!rodent dame <item> [cantidad]`).
    *   Equipa y desequipa ítems en diferentes ranuras (`!rodent equipar`, `!rodent desequipar`).
    *   Usa ítems (`!rodent usar [item]`).
    *   Fabrica ítems si tiene los materiales y una mesa de crafteo (`!rodent fabricar <item> [cantidad]`).

*   **Sistema de Combate y Defensa Robusto:**
    *   **🛡️ Auto-Defensa:** Detecta y ataca automáticamente mobs hostiles cercanos. Se equipa con la mejor armadura y espada disponible (intentará obtener equipo de diamante con `/give` si es OP y no lo tiene). Si no tiene espada, intentará huir.
    *   **Proteger Jugador (`!rodent protegeme`):** Vigila y defiende a un jugador específico de los mobs hostiles.
    *   Cancela la protección (`!rodent no_protejas`).

*   **Comunicación e Inteligencia Artificial:**
    *   Chatea con una IA externa (`!rodent chat <mensaje>`) usando la API de Shapes.
    *   Anuncia sus acciones y errores en el chat del juego.
    *   Proporciona ayuda sobre los comandos (`!rodent ayuda`).

## 📋 Prerrequisitos

*   Node.js (v16 o superior recomendado)
*   Un servidor de Minecraft Java Edition al que el bot pueda conectarse.

## 🚀 Instalación y Configuración

1.  **Clona el repositorio:**
    ```bash
    git clone https://github.com/TU_USUARIO/RodentBot-Minecraft-main.git
    cd RodentBot-Minecraft-main
    ```

2.  **Instala las dependencias:**
    ```bash
    npm install
    ```

3.  **Crea y configura tu archivo `.env`:**
    Copia el archivo `.env.example` a `.env` (o créalo manualmente):
    ```bash
    cp .env.example .env
    ```
    Luego, edita el archivo `.env` con tu configuración:

    ```dotenv
    # Prefijo para los comandos del bot en el chat (ej. !, ?, etc.)
    # Si se omite, el prefijo por defecto es "!"
    COMMAND="!"

    # Clave API para el servicio de Shapes (OpenAI compatible) para el comando !rodent chat
    SHAPES_API_KEY="tu_api_key_de_shapes"

    # Nombre del modelo a usar con la API de Shapes (ej. gpt-3.5-turbo, llama-2-7b-chat, etc.)
    MODEL_NAME="gpt-3.5-turbo"

    # IP del servidor de Minecraft
    # SERVER_IP="localhost"

    # Puerto del servidor de Minecraft
    # SERVER_PORT="25565"

    # Lista de mobs hostiles comunes, separados por comas (usado para auto-defensa y protegeme)
    # Asegúrate de que los nombres coincidan con los nombres internos de las entidades en Minecraft (en minúsculas).
    # Ejemplo: zombie,skeleton,creeper,spider,enderman,witch,slime,magma_cube,ghast,zombie_pigman,blaze,husk,stray,vindicator,evoker,vex
    COMMON_HOSTILES="zombie,skeleton,creeper,spider,enderman,witch,slime,magma_cube,ghast,zombie_pigman,blaze,husk,stray,vindicator,evoker,vex,pillager"
    ```
    *   **Nota:** `SERVER_IP` y `SERVER_PORT` están comentados en el `.env.example` porque el código actual en `index.js` usa `localhost:25565` directamente. Si deseas usar los valores del `.env`, descomenta las líneas correspondientes en `index.js`:
        ```javascript
        // host: process.env.SERVER_IP, // Dirección del servidor
        // port: process.env.SERVER_PORT, // Puerto del servidor
        ```
        y comenta/elimina:
        ```javascript
        host: "localhost",
        port: 25565,
        ```

## ▶️ Ejecutar el Bot

Una vez configurado, puedes iniciar el bot con:

```bash
node index.js
