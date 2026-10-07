# Neo Team

Aplicación local para preparar iteraciones y sincronizar los cambios con Azure DevOps a través de MCP. La organización, el proyecto, el equipo y el método de acceso se configuran desde la interfaz.

## Arranque

Requiere Node.js 22 o superior.

```sh
npm install
npm start
```

Abre **http://127.0.0.1:4310**. Para desarrollar, `npm run dev` reinicia el servidor al editarlo. No hay compilación de frontend: los archivos de `dist/` son las fuentes estáticas de la interfaz.

## Progreso de las consultas

Todas las operaciones que consultan o escriben en Azure DevOps muestran qué ocurre por detrás: importar, buscar proyectos y equipos, revisar, sincronizar, permisos, mantenimiento y estados. El panel indica:

- **Ahora**: la llamada que espera respuesta y cuánto tiempo lleva, o el paso de inicio de sesión en curso (reutilizar la sesión, ventana de cuentas del sistema, navegador abierto). Mientras espera al inicio de sesión se avisa cada 10 segundos.
- **Qué está pasando**: registro con hora de cada paso. Incluye el arranque del proceso MCP, cada llamada con su duración o su error y cada petición HTTP a Azure DevOps (método y ruta).

Si no aparece actividad nueva durante un rato y no hay un inicio de sesión pendiente, la consulta sigue esperando la respuesta de Azure DevOps; se puede cancelar cuando la operación lo permite. Los mensajes de autenticación son textos fijos: no se muestran tokens, URLs de inicio de sesión ni los registros internos de Microsoft.

## Secciones

La aplicación abre en **Inicio**. Pulsar el logotipo **neoteam** vuelve siempre a esta pantalla. Desde ella se accede a:

- **Planificación**: preparación de iteraciones, descrita en [Uso](#uso).
- **Mantenimiento**: lista todos los elementos de tipo `Functional Issue` del proyecto que no están cerrados.
  - **Configuración inicial:** se indica el tipo (editable) y se cargan sus estados posibles en el proyecto. Después se marcan los que cuentan como cerrados; vienen propuestos los de categoría `Completed` y `Removed`. La elección se guarda por proyecto y se cambia con **Cambiar**.
  - **Consulta:** es una sola llamada: una WIQL sobre el proyecto (`tipo = … AND State NOT IN (cerrados)`), cuyos campos se leen en lotes paralelos dentro del proceso MCP. No filtra por áreas ni equipos y ordena por prioridad y por última modificación.
  - **Uso:** se consulta al entrar y con **Actualizar**; el resultado solo se guarda en memoria. Permite buscar y filtrar por estado, y cada título abre el elemento en Azure DevOps.
  - **Límites:** muestra hasta 1000 elementos y avisa si hay más. Es de solo lectura. En el ejemplo se usan datos simulados.

- **Mi iteración**: los elementos asignados a tu cuenta en la iteración en curso del equipo, como en el taskboard de Azure DevOps.
  - **Quién:** la consulta usa `@Me`, es decir, la cuenta con la que has iniciado sesión en Azure DevOps. No hay que elegir persona.
  - **Qué iteración:** la que Azure marca como actual para el equipo (o, si no la marca, la que contiene la fecha de hoy). Con varios proyectos importados se muestra un tablero por equipo.
  - **Tablero:** filas por elemento padre (historia, PBI…) y columnas por estado de `Task`. Las tareas y bugs son tarjetas con su trabajo restante; los bugs con otros estados se colocan por categoría. Las tareas sin padre van en la última fila y los elementos en estado `Removed` no aparecen.
  - **Uso:** se consulta al entrar y con **Actualizar**; el resultado solo se guarda en memoria. Es de solo lectura y cada título abre el elemento en Azure DevOps. En el ejemplo se usan datos simulados.

- **Revisión de PRs**: revisa pull requests de Azure DevOps con GitHub Copilot y publica los comentarios que confirmes. Se describe en [Revisión de pull requests](#revisión-de-pull-requests).
- **Tickets de Jira**: agentes de GitHub Copilot que recolectan, reproducen, corrigen y verifican los tickets de un filtro de Jira. Se describe en [Tickets de Jira](#tickets-de-jira).

## Revisión de pull requests

1. En **Revisión de PRs**, **Mis pull requests** lista los pull requests activos del proyecto conectado que has creado y los que tienes asignados como revisor (con tu voto y si eres obligatorio). Cada uno tiene **Revisar**, y **Abrir** si ya tiene una revisión guardada. Se consulta al entrar en la sección y con **Actualizar**. Los asignados a un grupo o equipo del que formas parte, y no a ti directamente, no aparecen. También puedes pegar la URL de un pull request (`https://dev.azure.com/organización/proyecto/_git/repositorio/pullrequest/123`) o elige un repositorio del proyecto conectado y uno de sus pull requests activos.
2. **Revisar** lee el pull request en Azure DevOps (sus archivos cambiados y los comentarios existentes) y GitHub Copilot revisa el diff. El progreso se muestra y la revisión se puede cancelar.
3. El resultado se guarda en local: un resumen, una valoración y los comentarios propuestos por gravedad, cada uno anclado a su línea del pull request cuando esa línea aparece en el diff. Puedes editar el texto de cada comentario y marcar cuáles publicar (las sugerencias vienen desmarcadas). Cada comentario anclado a una línea muestra el fragmento de código del que habla, con esa línea resaltada. Cuando hay una corrección clara y acotada, el comentario incluye un **cambio propuesto**: se muestra como diff, marcando solo las palabras y símbolos que cambian, y con **Editar el cambio** puedes ajustar el código o vaciarlo para quitarlo. Se publica como sugerencia de Azure DevOps (bloque ` ```suggestion `), que aparece superpuesta a esas líneas con su botón para aplicarla; el comentario se ancla a las líneas completas que reemplaza.
4. **Publicar en Azure DevOps** muestra exactamente qué se va a crear y pide confirmación. Solo entonces se añaden hilos nuevos al pull request.

**Repositorio local (opcional).** Al elegir un repositorio en la lista, o en el detalle de una revisión, puedes indicar la carpeta de un clon suyo. Se comprueba que es un repositorio git con un remoto que apunta a `…/_git/<repositorio>`. Con la carpeta indicada, una revisión pide a Azure DevOps solo los datos del pull request: sus ramas, el commit revisado y los comentarios existentes. Después:

- hace `git fetch` de las ramas source y target en ese clon (solo actualiza las ramas remotas: no toca tus ramas ni tus cambios);
- calcula el diff con `git` entre la base común con la rama target y el commit del pull request, el mismo que se comprueba antes de publicar.

Así no se descarga cada archivo de Azure, no hay límite de descarga y se ve exactamente lo mismo que con `git`. Si el clon no consigue el commit del pull request (por ejemplo, porque `git fetch` pide credenciales), la revisión lo indica y no envía nada a Copilot. Vacía la carpeta para volver a leer de Azure DevOps. La carpeta se guarda por organización, proyecto y repositorio en `.neo-team/workspace.json`.

**Seguridad y datos**

- **Azure DevOps:** se accede con el mismo inicio de sesión de Microsoft y a través del MCP local. La única escritura crea hilos de comentario nuevos: no edita, resuelve ni borra comentarios, no vota ni completa el pull request.
- **Antes de publicar:** se comprueba que el pull request sigue activo y en el mismo commit que se revisó; si ha cambiado no se publica nada y hay que volver a revisarlo.
- **Sin duplicados ni marcas:** los comentarios no llevan ninguna firma ni referencia de Neo Team. Una publicación repetida busca primero en el pull request un comentario con el mismo texto y no reenvía lo que ya llegó a Azure. Los comentarios no se reintentan automáticamente.
- **Idioma:** el resumen y los comentarios se escriben y publican siempre en inglés (`Blocker`, `Major`, `Minor`, `Suggestion`), sea cual sea el idioma del pull request. La interfaz sigue en español.
- **GitHub Copilot:** se usa mediante el [Copilot SDK](https://github.com/github/copilot-sdk) oficial (fijado en 1.0.14) con la cuenta de GitHub iniciada en este equipo, y cada revisión consume la asignación de Copilot de esa cuenta (Business o Enterprise). La aplicación no pide ni guarda tokens de GitHub.
- **Qué recibe Copilot:** solo el diff del pull request, su descripción y los comentarios existentes, tratados como datos no confiables. Se ejecuta sin herramientas (ni terminal, ni archivos, ni MCP), en una carpeta vacía, sin leer la configuración ni las instrucciones personales de Copilot, y la sesión se borra al terminar.
- **Límites del diff:** de cada archivo solo se envían a Copilot los fragmentos cambiados, así que un archivo grande con un cambio pequeño se revisa igual. Se leen archivos de hasta 5 MB por versión y 50 MB en total por pull request; los archivos UTF-16 con marca de orden de bytes se leen como texto. No se envían los binarios, los que superan esos tamaños, los que tienen un diff demasiado complejo para calcularlo en 10 segundos ni los que no caben en el tamaño total del diff. La revisión indica cuáles son, para que los revises a mano.
- **Lectura de archivos:** cada versión de un archivo se lee por su blob y, si Azure DevOps no la sirve (a veces devuelve su mensaje de error como si fuera el contenido), por su ruta en el commit correspondiente. Si aun así no se puede leer, la revisión indica el archivo y el motivo de Azure en lugar de darlo por vacío.

**Iniciar sesión en GitHub.** Copilot no se ejecuta en el navegador sino en el servidor local de Neo Team, así que no usa la sesión de GitHub abierta en el navegador. Usa, por este orden: `COPILOT_GITHUB_TOKEN` en el entorno del servidor, la sesión guardada por Copilot CLI o la de GitHub CLI. Se inicia una sola vez desde una terminal:

- **Copilot CLI (recomendado):** `npm install -g @github/copilot`, después `copilot` y `/login`. Guarda la sesión solo para Copilot y no cambia la cuenta de `gh`.
- **GitHub CLI:** `gh auth login --web`. Cambia la cuenta activa de `gh`. Copilot no acepta los tokens clásicos (`ghp_…`).
- **Cuentas de empresa gestionadas (github.com/enterprises/…):** el login muestra un código que se autoriza en `github.com/login/device` con la cuenta abierta en el navegador. Si allí tienes la personal, se autoriza esa. Abre el enlace en una ventana privada, entra con la cuenta de la empresa y escribe el código.

Al abrir la sección se comprueba la sesión, aunque no haya un proyecto conectado, y se muestra la cuenta que se usará. Sin sesión aparecen los comandos para copiarlos y **Comprobar**; no hace falta reiniciar Neo Team tras iniciar sesión, salvo si usas la variable de entorno. Una revisión comprueba la sesión antes de leer el pull request, así que sin ella no se descarga nada de Azure DevOps. La organización debe permitir el uso de Copilot CLI/SDK a tu asiento. **Modelo de IA:** junto a la cuenta de Copilot hay un desplegable con los modelos que tu cuenta puede usar, con su multiplicador de coste (×). La elección se guarda y se usa en las siguientes revisiones; cada revisión indica con qué modelo se hizo. «Modelo predeterminado» usa `NEO_TEAM_COPILOT_MODEL` si está definido o, si no, el predeterminado de tu plan.

En el ejemplo, los pull requests, la revisión y la publicación se simulan: no se contacta con Azure DevOps ni con GitHub.

## Tickets de Jira

Un tablero cuyas columnas son agentes de GitHub Copilot. Cada ticket pasa por **Recolectar → Reproducir → Solucionar → Verificar → Resueltos**; si la verificación falla vuelve a Solucionar con el informe del fallo, hasta el número de **iteraciones máximas** configurado. No depende de Azure DevOps: en modo **Real** se entra desde Inicio aunque Azure no esté conectado.

**Conectar Jira.** Con el selector de la cabecera en **Real**, abre **Tickets de Jira**. La primera vez la sección es el formulario (después, **Configuración**):

- **Jira:** URL (`https://empresa.atlassian.net` o la de Data Center), tipo, correo de la cuenta (Cloud), token y **filtro** (su número, su URL con `?filter=` o `?jql=`, o una consulta JQL; los filtros del sistema como `?filter=-1`, «Mis incidencias abiertas», se traducen a su consulta). El token es un [API token de Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens) (Cloud, junto con el correo) o un token de acceso personal (Data Center: Perfil → Tokens de acceso personal). Se guarda solo en `.neo-team/jira-token` con permisos privados y nunca se envía a la interfaz; `NEO_TEAM_JIRA_TOKEN` lo sustituye.
- **Aplicación:** repositorio local, rama base, comando de compilación y cómo arrancar la aplicación. Los dos comandos son opcionales: si faltan, el agente los averigua y los guarda como aprendizaje.
- **Carpeta de tickets:** por defecto `.neo-team/jira/`.

**Conectar** guarda y comprueba al momento la conexión con la cuenta del token; la barra muestra con qué cuenta está conectado, y si Jira la rechaza lo indica y la configuración queda guardada para corregirla. GitHub Copilot usa la misma sesión que la revisión de PRs: si no hay sesión, la sección muestra cómo iniciarla y **Copilot** en la barra la vuelve a comprobar.

**Recolectar** consulta el filtro (hasta 200 tickets) y descarga los nuevos o los que han cambiado en Jira. Cada ticket queda en su carpeta:

- `descripcion.md`: campos, descripción y lista de adjuntos; `comentarios.md`: los comentarios en orden. El formato de Jira se convierte a Markdown y las referencias a adjuntos (`!captura.png!`, `[^video.mp4]`) apuntan a la copia local.
- `adjuntos/`: cada adjunto con su nombre de Jira, que es como lo citan los textos (si dos se llaman igual, el más antiguo lleva su id). De cada vídeo se extrae un fotograma cada 2 segundos en `adjuntos/<vídeo>.fotogramas/` si `ffmpeg` está instalado, para que los agentes puedan verlo.
- Los informes de cada agente (`resumen.md`, `reproduccion-N.md`, `solucion-N.md`, `verificacion-N.md`), `evidencias/`, `reproducir.ps1`, `compilacion-N.log` y `estado.json`.

**Sincronizar** consulta en Jira los tickets que ya están en el tablero: los terminados allí (estado de categoría *Done*) se quitan del tablero, conservando su carpeta y su rama, y aparecen en «Mostrar quitados» como «Cerrado en Jira»; los que han cambiado se vuelven a descargar, con sus comentarios y adjuntos nuevos, sin moverlos de columna. También actualiza a quién están asignados. Avisa de los que ya no existen o a los que no tienes acceso.

**Asignado.** Cada tarjeta muestra a quién está asignado el ticket en Jira («tú» si es tu cuenta, o «Sin asignar»). Un ticket asignado a otra persona queda fuera del modo automático: solo se ejecuta con ▶ sobre ese ticket. El candado de la tarjeta (o «Incluir en automático» / «Solo manual» en su detalle) cambia esto ticket a ticket.

**Agentes y modelos.** Recolectar no usa IA. Las demás columnas tienen su agente y un selector de modelo; **Auto** elige el más reciente de tu cuenta de Copilot según la dificultad: medio para reproducir y verificar (Sonnet) y avanzado para solucionar (Opus).

- **Recolectar (sin IA):** se hace con código y no consume tokens. Escribe `resumen.md`, un índice del ticket: los pasos que enumeran la descripción y los comentarios, los comentarios y cada adjunto con su tipo y sus fotogramas. Un ticket sin descripción, comentarios ni adjuntos se queda con una pregunta en vez de llegar a un agente.
- **Reproducir:** entiende el ticket (descripción, comentarios, imágenes y fotogramas), arranca la versión actual y la maneja con [winapp CLI](https://github.com/microsoft/winappcli) (`winapp ui inspect`, `invoke`, `set-value`, `wait-for`, `screenshot`, `record`…). Guarda evidencias y un `reproducir.ps1` que repite los pasos.
- **Solucionar:** trabaja en una copia aparte del repositorio (`git worktree` en `<ticket>/codigo`, rama `neo/<ticket>`), así que no toca tu clon ni tus cambios. Busca la causa, corrige y compila. Si hay comando de compilación, Neo Team lo vuelve a ejecutar: si falla, el ticket vuelve a Solucionar con el registro. No hace commits.
- **Verificar:** arranca la compilación corregida, repite `reproducir.ps1` y comprueba lo relacionado.

**Semáforo de cada columna.** Verde (**autopilot**): su agente actúa solo. Ámbar (**avisar**): los tickets esperan en la columna marcados «Espera tu OK» y ▶ aprueba ese paso. Rojo (**nada**): su agente no actúa, ni siquiera con ▶.

**Uso.** **Empezar**, arriba, procesa los tickets pendientes de las columnas en verde que no tengan el candado puesto, uno tras otro y terminando cada uno antes de pasar al siguiente (un solo agente a la vez, porque manejan el escritorio); **Pausar** deja terminar el paso en curso y para. ▶ en una tarjeta trabaja solo sobre ese ticket: pausa el resto y lo lleva por las columnas siguientes mientras estén en verde. El ticket en proceso y su columna se resaltan, la tarjeta muestra lo último que hace el agente y ■ lo detiene al momento (el paso queda pendiente). La clave de cada tarjeta enlaza con el ticket en Jira.

**Preguntas.** Cuando un agente no puede seguir (le falta información, una decisión o un acceso) se bloquea con una pregunta concreta, o el ticket se bloquea al agotar los intentos. La tarjeta muestra la pregunta y un campo para responder: **Responder** (o Ctrl+Enter) guarda la respuesta en el ticket y lo retoma; esa respuesta y las anteriores se pasan a todos los agentes que trabajen después en él.

**Detalle.** Al pulsar un ticket se abre en una ventana con una pestaña por cada paso completado (resultado, fecha, modelo, tokens, pregunta y respuesta, informe y archivos de ese paso) y otra con la descripción, los comentarios y los archivos del ticket. Desde ahí se ejecuta su paso, se mueve a otra columna (reinicia los intentos), se abre su carpeta o se quita del tablero.

**Aprendizaje.** Antes de actuar, cada agente lee los aprendizajes generales y los de su columna; cuando descubre algo reutilizable (cómo compilar o arrancar, selectores que funcionan, dónde está el código, trampas) lo guarda con la herramienta `neo_learn`. Están en `<carpeta de tickets>/aprendizajes/`; el botón con el libro de cada columna muestra cuántos tiene su agente y los abre para editarlos, junto con los comunes a todos.

**Logs en Jira.** Desactivado por defecto. Al activarlo, cada paso que termina un agente se publica como comentario nuevo en su ticket de Jira: el agente, el resultado, la pregunta si la hay y un extracto del informe. Es lo único que Neo Team escribe en Jira; si falla, el paso continúa y su pestaña indica que no se publicó.

**Permisos de los agentes.** Leen cualquier archivo, escriben solo en la carpeta del ticket (y Solucionar en su copia del código) y ejecutan comandos de terminal con tu usuario, salvo `git commit`, `push`, `reset`, `clean`, `rebase` y similares, que se rechazan. No usan MCP ni la web. Reproducir y Verificar necesitan Windows con escritorio desbloqueado; la barra indica si `winapp`, `ffmpeg` y Copilot están disponibles. Cada agente consume la asignación de Copilot de tu cuenta.

En el ejemplo, tres tickets de una aplicación ficticia recorren el tablero con agentes simulados: uno se resuelve directamente, otro necesita una segunda corrección y otro se bloquea con una pregunta hasta que la respondes. Nada se pide a Jira ni a Copilot.

## Uso

1. En modo **Azure DevOps** y sin conexión configurada, la página entera es el formulario **Conectar Azure DevOps** (no hay botón aparte en la cabecera). Introduce tu organización o cualquier URL suya copiada del navegador (`https://dev.azure.com/organización/…` o `https://organización.visualstudio.com`).
2. Elige **Iniciar sesión con Microsoft**. **Buscar proyectos** abre el acceso de Microsoft cuando sea necesario y carga las opciones del campo. Puedes escribir los nombres directamente. **Buscar equipos** carga los equipos del proyecto indicado.
3. Pulsa **Conectar e importar**. También puedes guardar la configuración sin conectar. El modo **Azure CLI** utiliza una sesión previamente autenticada; el tenant de Entra es opcional.
4. En **1 · Configuración**, marca los estados que se importan para cada tipo de tarea o bug y proyecto. **Sincronizar**, al principio de Configuración, actualiza las tareas; las reglas también se usan en las siguientes importaciones. En Prueba se aplican sobre el ejemplo. La configuración de mantenimiento está en su propia sección.
5. En **2 · Iteración**, elige el período que vas a planificar. Los pasos siguientes trabajan sobre él.
6. En **3 · Capacidad**, define las horas diarias, las ausencias personales y los días libres comunes. Con varios proyectos es una única disponibilidad.
7. En **4 · Tareas**, revisa las tareas de la iteración anterior cuando esté disponible y prepara la elegida. Puedes arrastrar tareas a una persona o abrirlas para cambiar responsable, iteración y horas pendientes.
8. En **5 · Cambios pendientes**, compara el borrador con Azure y revisa las asignaciones, capacidades y comentarios antes de sincronizar.

Cada sección tiene su dirección (`/planificacion/capacidad`, `/mi-iteracion`, `/mantenimiento`, `/revision-prs/<revisión>`, `/jira`, `/jira/configuracion`, `/jira/<ticket>`, `/permisos`): al recargar se vuelve al mismo sitio, con el ticket o la revisión abiertos, y los botones atrás y adelante del navegador recorren las secciones. Inicio muestra seis recuadros con el icono y el título de Planificación, Mi iteración, Mantenimiento, Revisión de PRs, Tickets de Jira y Permisos. El logotipo vuelve a Inicio. Al volver a Planificación se conserva el paso abierto durante la sesión. Los cambios pendientes se revisan desde el paso **Cambios pendientes**. El selector de la cabecera alterna entre **Prueba** y **Real** (Azure DevOps y Jira) y el aviso de modo permanece visible en todas las secciones, salvo mientras el formulario de conexión ocupa la página. Prueba usa datos de ejemplo y simula los cambios sin conectarse a Azure DevOps; Permisos solo está disponible en modo Azure DevOps. Los datos y cambios locales de ambos modos se conservan por separado al alternar.

Los filtros de mantenimiento admiten búsquedas sin tildes y se pueden limpiar con un botón. La revisión de PRs muestra cuántos comentarios se publicarán y solo habilita la publicación cuando hay una selección pendiente y el pull request está activo.

**Añadir proyecto** conserva los proyectos importados y, antes de unir el nuevo, vuelve a leer de Azure las iteraciones de los ya importados para comparar siempre con sus fechas actuales. **Actualizar toda la planificación** refresca todos; si falla uno, conserva la copia completa anterior.

### Cambios de estado en local

En el editor de tareas y bugs, elige **Estado** y pulsa **Guardar en local**. Cada estado distinto que guardes se añade al historial pendiente de esa tarea. Por ejemplo, guardar **Ready for Test** y después **Closed** prepara dos actualizaciones, en ese orden. Volver al estado inicial también añade un paso; para cancelar el historial usa **Deshacer cambios** o **Descartar**. Guardar otra edición sin cambiar el estado no duplica el paso.

La revisión muestra la secuencia completa antes de enviarla. Al sincronizar, cada transición usa la revisión confirmada de Azure y se guarda individualmente. Si falla un paso, quedan pendientes ese paso y los siguientes. Una respuesta perdida se contrasta con el estado y la revisión de Azure antes de continuar; si no se puede determinar el resultado, se pide elegir qué versión conservar. Los elementos nuevos se crean primero y después recorren los estados guardados. El modo de prueba simula el mismo comportamiento.

No hay configuración de cierre por tipo ni se añaden pasos automáticamente. **Marcar completada** prepara únicamente el estado completado que indica Azure. Si necesitas pasar antes por otro estado, guárdalo en el editor antes de completar la tarea. Las decisiones de importación y los estados cerrados de mantenimiento siguen siendo ajustes independientes.

### Planificación conjunta

Los proyectos deben pertenecer a la misma organización. Se utiliza un equipo por proyecto para evitar duplicar capacidades. Las iteraciones con las mismas fechas comparten un período de planificación; se rechazan calendarios solapados con fechas distintas y se mantienen separadas las iteraciones sin fechas. Solo se puede asignar una tarea a una iteración disponible en su proyecto.

La capacidad inicial toma una referencia por persona y nunca suma automáticamente sus capacidades de varios proyectos. Revísala en el paso **Capacidad**. La tabla **Capacidad por proyecto** reparte esa disponibilidad en proporción a las horas pendientes de las tareas asignadas: por ejemplo, 30 h de tareas en A y 10 h en B reparten una capacidad global de 32 h en 24 h para A y 8 h para B. Sin horas de tareas, la disponibilidad queda sin repartir. Las tareas sin estimar impiden enviar el reparto.

Las personas con capacidad efectiva de **0 h** aparecen al final del paso Capacidad, resaltadas en rojo. Quedan fuera de Repartir ramas, Tareas y del cálculo de capacidad por proyecto. Si ya tenían tareas asignadas, estas siguen visibles en un bloque «Fuera del reparto» para poder corregirlas, pero no consumen capacidad ni se distribuyen entre proyectos.

La revisión muestra las horas diarias que se enviarán a cada proyecto y persona, considerando su calendario y sus días libres. Los días libres globales se incluyen como ausencias personales en cada proyecto. Azure recibe horas diarias con dos decimales, por lo que pueden aparecer pequeñas diferencias de redondeo. Si falla alguna tarea, se conserva el reparto de capacidad pendiente. Las capacidades confirmadas se guardan individualmente para poder reintentar los fallos sin repetir escrituras confirmadas.

**Probar con un ejemplo** ofrece un espacio separado. Su sincronización es una simulación local y nunca contacta con Azure DevOps. Puedes entrar y salir conservando ambos borradores.

## Qué importa y sincroniza

- Recupera también los padres que no estén en los niveles visibles o áreas del equipo como contexto, sin recorrer sus tareas hermanas ni permitir escrituras remotas sobre esos padres.
- Importa integrantes completos del equipo, sus iteraciones, los niveles del backlog, los work items de cada iteración y las tareas hijas accesibles dentro de las áreas del equipo.
- Importa tareas y bugs en los estados seleccionados en Configuración. Inicialmente se incluyen los estados abiertos y `Resolved`, y se excluyen `Completed` y `Removed`; se puede cambiar cualquier estado del catálogo. Los padres se recuperan por ID como contexto, independientemente de su estado, para mantener la jerarquía. Los filtros se aplican en WIQL antes de descargar los elementos. Al actualizar se conservan los cambios locales pendientes.
- Consulta capacidad, calendario laboral, ausencias personales y días libres del equipo. Una capacidad que no se ha podido consultar se muestra como desconocida, acompañada de un aviso.
- Mantiene las estimaciones en puntos separadas de las horas. La carga utiliza **RemainingWork**; los puntos se muestran como información. No se convierten puntos a horas.
- Sincroniza únicamente los campos editados: `System.Title`, `System.AssignedTo`, `System.IterationPath`, `Microsoft.VSTS.Common.Priority`, las estimaciones disponibles y `System.State`. El resto de campos conserva su último valor local; los estados guardados se envían secuencialmente por tarea. El editor ofrece el catálogo de estados del proyecto y tipo; **Actualizar estados** vuelve a consultarlo con progreso y cancelación.
- Las tarjetas se ordenan por prioridad e identificador. Mover una tarjeta cambia su asignación e iteración; no escribe el orden de Azure (`StackRank`). El reparto de participantes no crea cambios remotos en los padres. Solo las tareas y bugs elegidos pasan al borrador de la iteración.
- Permite crear elementos en local y sincronizarlos con su proyecto de origen; no elimina work items ni modifica fechas de iteración. Las tareas y bugs pueden cambiar a cualquier estado de su catálogo, sujeto a las reglas de Azure al sincronizar. **Actualizar datos** requiere sincronizar o descartar el borrador previo.
- La importación excluye todas las iteraciones pasadas, incluidas sus tareas y capacidades. Consulta el backlog sin iteración y las iteraciones actuales o futuras del equipo. Antes de descargar tareas, clasifica los estados por tipo; ante estados personalizados sin categoría pide una decisión con un elemento de muestra y la guarda por proyecto y tipo. `Discarded` se excluye por defecto. Lee campos en lotes de hasta 200, con un máximo de cuatro lotes concurrentes y paginación por ID sin truncamiento silencioso. Los padres fuera del área o de las iteraciones consultadas se leen por ID como contexto, incluidos los cerrados. Un fallo conserva la copia anterior.

## MCP y autenticación

El servidor HTTP local utiliza un cliente MCP por stdio. `server/mcp-server.js` registra las implementaciones de `core`, `work` y `work-items` del [MCP oficial de Microsoft](https://github.com/microsoft/azure-devops-mcp), fijado en **2.10.0**. Reutiliza su autenticación Microsoft y las herramientas oficiales de lectura y escritura.

La versión oficial fijada no expone todos los integrantes del equipo ni los días libres compartidos. El servidor local incorpora dos herramientas MCP de solo lectura, `neo_team_members` y `neo_team_days_off`, que usan el SDK de Azure y la misma sesión de autenticación. Son extensiones de Neo Team, no herramientas oficiales de Microsoft. La aplicación HTTP no hace llamadas directas a la API de Azure.

Se verifican las herramientas anunciadas al conectar. Las actualizaciones usan `wit_work_item_write`, con una operación atómica `test /rev` y el número de revisión remoto antes de los cambios. Las dependencias están fijadas porque se importan implementaciones internas del MCP; actualizarlas requiere revisar contratos y ejecutar las pruebas.

El acceso debe permitir leer proyectos/equipos y work items, y editar los work items que quieras sincronizar. La aplicación no solicita ni guarda contraseñas ni PAT. El proceso MCP conserva temporalmente el token de acceso en memoria; al cerrar la aplicación termina esa sesión. El SDK de Microsoft puede usar su propia caché del sistema. Puede ser necesario volver a iniciar sesión al arrancar de nuevo.

## Persistencia y conflictos

El reparto compartido y las exclusiones de personas por rama son locales y persisten entre recargas, exportaciones, sincronizaciones y actualizaciones de datos del mismo equipo (para elementos y miembros que sigan presentes). Descartar cambios de Azure no borra el reparto ni sus exclusiones. Por eso las tareas ya asignadas en la iteración siempre siguen visibles en el selector, incluso si su participación local está excluida. Cada tarea mantiene un solo `System.AssignedTo` al sincronizar; compartir participantes no duplica tareas ni capacidad.

La configuración y ambas planificaciones se guardan en `.neo-team/workspace.json`, excluido de Git. Se escribe mediante un archivo temporal y reemplazo atómico, con permisos privados en sistemas que los soportan. Para una copia íntegra, conserva el archivo de trabajo con la aplicación detenida.

Los cambios locales tienen una versión para impedir sobrescrituras desde ventanas desactualizadas. La revisión compara cada campo editado con su valor importado y el remoto: conserva cambios remotos ajenos al borrador y señala los conflictos en el mismo campo. Elegir **Conservar versión de Azure** descarta todos los cambios locales de esa tarea; **Mantener mis cambios** los vuelve a preparar sobre la versión de Azure que ya leyó la revisión. La decisión se aplica al momento: no se vuelve a consultar Azure ni se repasan los demás cambios, y se puede sincronizar sin revisar de nuevo. Lo mismo ocurre con los conflictos de capacidad.

La sincronización no es una transacción entre tareas: cada éxito se guarda por separado, los fallos permanecen pendientes y una revisión posterior reconoce los valores ya aplicados sin repetir escrituras. Las creaciones nunca se reenvían automáticamente; si se pierde la respuesta, se buscan en Azure antes de reenviarlas.

El servidor escucha exclusivamente en `127.0.0.1`, valida Host y Origin, rechaza las peticiones a `/api/` que el navegador marca como de otro sitio (`Sec-Fetch-Site: cross-site`) y requiere un token de sesión para las consultas y modificaciones. Si el servidor se reinicia, la interfaz renueva el token y repite la acción solo si la planificación no ha cambiado entretanto. No se debe exponer a Internet. Para cambiar el puerto o el directorio de datos se pueden usar `NEO_TEAM_PORT` y `NEO_TEAM_DATA_DIR`. Ejecuta una sola instancia por directorio de datos.

## Verificación

```sh
npm run check
npm test
```

Las pruebas cubren persistencia, aislamiento del ejemplo, validación del borrador, capacidad/calendarios, conflictos, revisiones concurrentes, sincronización parcial, recuperación de confirmaciones inciertas, protección HTTP y los contratos del MCP. Se comprueba el arranque real del MCP y sus esquemas sin autenticarse. Las operaciones contra Azure se prueban con respuestas controladas: **la conexión y sincronización con una organización real requieren configurarla e iniciar sesión desde la aplicación y no se han verificado en esta entrega**.

La interfaz incluye herramientas WebMCP opcionales para leer el plan y preparar borradores cuando el navegador las soporte. No permiten sincronizar directamente. Se han comprobado los flujos de ejemplo en navegador, incluyendo vistas de escritorio y móvil. No se ha validado WebMCP en navegador.

### Creaciones y cambios pendientes

Usa el **+** de una rama para crear features, historias, tareas y bugs en local. Los elementos nuevos y editados se señalan como pendientes; el paso 5 muestra el total. Los títulos también se pueden editar. Las creaciones se envían después de revisar, con los padres antes que los hijos.

**Duplicar** copia también la descripción del original (en los bugs, *Repro Steps*). Se lee de Azure DevOps al crear la copia, así que refleja la versión actual; el duplicado de un duplicado la toma del mismo original.

Al revisar los cambios, cada creación se valida en Azure DevOps sin guardarse. Si el proceso del proyecto exige una descripción y no la tiene, la creación muestra un aviso y un campo para escribirla allí mismo: se guarda en local y se envía con la creación. Otras reglas que Azure no acepte se muestran como aviso en la creación afectada.

Las creaciones no añaden ninguna etiqueta ni marca propia en Azure DevOps. Se validan en Azure antes de enviarlas. Si se pierde la respuesta de un envío, la creación queda pendiente y no se puede editar ni descartar. La siguiente sincronización la busca antes de reenviarla: mismo tipo y título, creada por tu cuenta desde el día del envío, con el mismo padre y que no esté ya en la planificación. Si la encuentra, la recupera sin duplicarla. Si hay varias coincidencias, queda bloqueada para que compruebes cuál es. Si no aparece tras varios intentos, se envía. Al duplicar no se copian las etiquetas `neo-create-…` que dejaban las versiones anteriores.

Los cambios existentes comparan los valores originales, locales y remotos. La revisión muestra los conflictos, pero no bloquea: al sincronizar se envía la versión local, que sobrescribe lo que haya en Azure en los campos editados. En ese caso el botón lo indica (**Sincronizar y sobrescribir N conflictos**). Solo se envían los campos editados; los cambios remotos en otros campos se conservan.

Si durante la revisión no se puede leer Azure, la revisión lo avisa y las escrituras se protegen, porque nadie ha visto la versión remota: una tarea se envía con el `test /rev` de su copia local y solo se aplica si no ha cambiado desde la importación; una capacidad se vuelve a leer justo antes de escribirla y no se sobrescribe si ha cambiado (si Azure sigue sin responder, se envía el valor local). Las lecturas por lotes omiten los elementos eliminados o sin acceso, que se señalan uno a uno sin impedir revisar el resto. Las llamadas que agotan el tiempo, pierden la conexión o reciben un error temporal se reintentan hasta tres veces. Los fallos parciales conservan los elementos pendientes. El reparto compartido de ramas y las confirmaciones personales son locales; las asignaciones de responsable sí se envían a Azure.

La creación real depende de los tipos y campos habilitados en el proceso del proyecto. Se han probado los contratos MCP y escenarios de error con datos controlados; no se ha creado ningún elemento en una organización real durante el desarrollo.

## Actualizar una sección

Cada paso de planificación ofrece su propia actualización: **Actualizar iteraciones**, **Actualizar capacidad** y **Actualizar tareas y jerarquía**. Repartir ramas y elegir tareas comparten el backlog. Se consulta solo la información de ese ámbito en los proyectos importados y se conservan los datos de las demás secciones. Para actualizar tareas se reutilizan las iteraciones y los integrantes ya importados; usa sus botones o **Actualizar toda la planificación** si también han cambiado.

Los borradores de tareas impiden actualizar tareas, pero no capacidad, y viceversa. Actualizar el calendario requiere resolver ambos borradores porque sus fechas afectan a los dos. Un fallo o cancelación conserva la copia anterior completa. Al actualizar capacidad con varios proyectos, se reconstruye la disponibilidad global sumando las horas de sus asignaciones de Azure y teniendo en cuenta los días laborables y ausencias.

Mantenimiento, grupos de permisos e informe de un grupo mantienen sus botones independientes de actualización; no vuelven a importar la planificación.

## Diagnóstico de errores

Cuando una operación falla de forma inesperada, el recuadro de progreso muestra el motivo y el servidor guarda un informe en `.neo-team/last-error.json` (o en `NEO_TEAM_DATA_DIR`). Incluye el paso en el que se detuvo, la actividad reciente y la pila del error; también se escribe en la terminal del servidor. Los errores internos indican el paso y el archivo y la línea donde ocurrieron. Si el servidor se detiene durante una operación, deja el mismo informe antes de salir; un rechazo de promesa no capturado se registra sin detener el servidor. Los errores de validación de los cambios locales solo se muestran en la interfaz y no generan informe. Si el puerto ya está en uso, la terminal lo indica al arrancar. El informe no contiene credenciales ni datos de la planificación.
