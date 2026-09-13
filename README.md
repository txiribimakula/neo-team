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

## Uso

1. En **Conectar Azure DevOps**, introduce tu organización o su URL.
2. Elige **Iniciar sesión con Microsoft**. **Buscar proyectos** abre el acceso de Microsoft cuando sea necesario y carga las opciones del campo. Puedes escribir los nombres directamente. **Buscar equipos** carga los equipos del proyecto indicado.
3. Pulsa **Conectar e importar**. También puedes guardar la configuración sin conectar. El modo **Azure CLI** utiliza una sesión previamente autenticada; el tenant de Entra es opcional.
4. En **1 · Iteración**, elige la iteración que vas a planificar. Los pasos siguientes trabajan sobre ella; el botón de la cabecera vuelve a este paso para cambiarla.
5. En **Capacidad**, define las horas diarias y las ausencias de cada persona, y los días libres comunes. Con varios proyectos es una única disponibilidad, que se conserva al actualizar.
6. En **Repartir ramas**, busca personas y marca su participación. Se guarda en local y se hereda a las tareas descendientes.
7. En **Elegir tareas**, utiliza la vista del equipo o por persona, estima las horas pendientes y asigna las tareas. Cada tarea indica su proyecto. La persona debe pertenecer al equipo de ese proyecto.
8. En **Revisar y sincronizar**, comprueba los cambios de tareas y capacidad antes de enviarlos. Se comparan con Azure para detectar conflictos. La revisión de la iteración anterior solo aparece en copias antiguas o en el ejemplo; las nuevas importaciones excluyen todas las iteraciones pasadas.

**Añadir proyecto** conserva los proyectos importados. **Actualizar datos** refresca todos; si falla uno, conserva la copia completa anterior. **Exportar** descarga la planificación completa.

### Planificación conjunta

Los proyectos deben pertenecer a la misma organización. Se utiliza un equipo por proyecto para evitar duplicar capacidades. Las iteraciones con las mismas fechas comparten un período de planificación; se rechazan calendarios solapados con fechas distintas y se mantienen separadas las iteraciones sin fechas. Solo se puede asignar una tarea a una iteración disponible en su proyecto.

La capacidad inicial toma una referencia por persona y nunca suma automáticamente sus capacidades de varios proyectos. Revísala en el paso **Capacidad**. La tabla **Capacidad por proyecto** reparte esa disponibilidad en proporción a las horas pendientes de las tareas asignadas: por ejemplo, 30 h de tareas en A y 10 h en B reparten una capacidad global de 32 h en 24 h para A y 8 h para B. Sin horas de tareas, la disponibilidad queda sin repartir. Las tareas sin estimar impiden enviar el reparto.

La revisión muestra las horas diarias que se enviarán a cada proyecto y persona, considerando su calendario y sus días libres. Los días libres globales se incluyen como ausencias personales en cada proyecto. Azure recibe horas diarias con dos decimales, por lo que pueden aparecer pequeñas diferencias de redondeo. Si falla alguna tarea, se conserva el reparto de capacidad pendiente. Las capacidades confirmadas se guardan individualmente para poder reintentar los fallos sin repetir escrituras confirmadas.

**Probar con un ejemplo** ofrece un espacio separado. Su sincronización es una simulación local y nunca contacta con Azure DevOps. Puedes entrar y salir conservando ambos borradores.

## Qué importa y sincroniza

- Recupera también los padres que no estén en los niveles visibles o áreas del equipo como contexto, sin recorrer sus tareas hermanas ni permitir escrituras remotas sobre esos padres.
- Importa integrantes completos del equipo, sus iteraciones, los niveles del backlog, los work items de cada iteración y las tareas hijas accesibles dentro de las áreas del equipo.
- Sólo guarda elementos abiertos: consulta las categorías de estado de cada tipo y excluye `Completed` y `Removed`, incluidos los estados personalizados y los padres cerrados. Conserva las tareas hijas abiertas y los elementos `Resolved` pendientes de validación. Los estados se filtran en WIQL antes de leer los campos, y el progreso indica los elementos abiertos obtenidos; al actualizar los datos también desaparecen de la copia local los que se hayan cerrado desde la importación anterior.
- Consulta capacidad, calendario laboral, ausencias personales y días libres del equipo. Una capacidad que no se ha podido consultar se muestra como desconocida, acompañada de un aviso.
- Mantiene las estimaciones en puntos separadas de las horas. La carga utiliza **RemainingWork**; los puntos se muestran como información. No se convierten puntos a horas.
- Sincroniza únicamente los campos editados: `System.AssignedTo`, `System.IterationPath`, `Microsoft.VSTS.Common.Priority`, `Microsoft.VSTS.Scheduling.RemainingWork` y `System.State`. El estado solo se cambia al marcar una tarea o bug como completado, con el estado que elijas como completado para su tipo. La importación propone el primer estado de categoría `Completed`. Si no se conoce, al marcar la primera tarea de ese tipo se muestra una lista para elegirlo: los estados de los datos importados, nombres habituales y un nombre libre. Puedes consultar todos los estados del flujo en Azure DevOps bajo demanda; esa consulta muestra su progreso y se puede cancelar. La elección se recuerda al volver a importar y se cambia desde **Al completar**, en el paso 2; las tareas ya marcadas pasan al nuevo estado.
- Las tarjetas se ordenan por prioridad e identificador. Mover una tarjeta cambia su asignación e iteración; no escribe el orden de Azure (`StackRank`). El reparto de participantes no crea cambios remotos en los padres. Solo las tareas y bugs elegidos pasan al borrador de la iteración.
- Permite crear elementos en local y sincronizarlos con su proyecto de origen; no elimina work items ni modifica fechas de iteración. Los estados solo cambian al marcar tareas y bugs como completados. **Actualizar datos** requiere sincronizar o descartar el borrador previo.
- La importación excluye todas las iteraciones pasadas, incluidas sus tareas y capacidades. Consulta el backlog sin iteración y las iteraciones actuales o futuras del equipo. Antes de descargar tareas, clasifica los estados por tipo; ante estados personalizados sin categoría pide una decisión con un elemento de muestra y la guarda por proyecto y tipo. `Discarded` se excluye por defecto. Lee campos en lotes de hasta 200, con un máximo de cuatro lotes concurrentes y paginación por ID sin truncamiento silencioso. Los padres abiertos fuera del área se leen como contexto mediante consultas filtradas. Un fallo conserva la copia anterior.

## MCP y autenticación

El servidor HTTP local utiliza un cliente MCP por stdio. `server/mcp-server.js` registra las implementaciones de `core`, `work` y `work-items` del [MCP oficial de Microsoft](https://github.com/microsoft/azure-devops-mcp), fijado en **2.10.0**. Reutiliza su autenticación Microsoft y las herramientas oficiales de lectura y escritura.

La versión oficial fijada no expone todos los integrantes del equipo ni los días libres compartidos. El servidor local incorpora dos herramientas MCP de solo lectura, `neo_team_members` y `neo_team_days_off`, que usan el SDK de Azure y la misma sesión de autenticación. Son extensiones de Neo Team, no herramientas oficiales de Microsoft. La aplicación HTTP no hace llamadas directas a la API de Azure.

Se verifican las herramientas anunciadas al conectar. Las actualizaciones usan `wit_work_item_write`, con una operación atómica `test /rev` y el número de revisión remoto antes de los cambios. Las dependencias están fijadas porque se importan implementaciones internas del MCP; actualizarlas requiere revisar contratos y ejecutar las pruebas.

El acceso debe permitir leer proyectos/equipos y work items, y editar los work items que quieras sincronizar. La aplicación no solicita ni guarda contraseñas ni PAT. El proceso MCP conserva temporalmente el token de acceso en memoria; al cerrar la aplicación termina esa sesión. El SDK de Microsoft puede usar su propia caché del sistema. Puede ser necesario volver a iniciar sesión al arrancar de nuevo.

## Persistencia y conflictos

El reparto compartido y las exclusiones de personas por rama son locales y persisten entre recargas, exportaciones, sincronizaciones y actualizaciones de datos del mismo equipo (para elementos y miembros que sigan presentes). Descartar cambios de Azure no borra el reparto ni sus exclusiones. Por eso las tareas ya asignadas en la iteración siempre siguen visibles en el selector, incluso si su participación local está excluida. Cada tarea mantiene un solo `System.AssignedTo` al sincronizar; compartir participantes no duplica tareas ni capacidad.

La configuración y ambas planificaciones se guardan en `.neo-team/workspace.json`, excluido de Git. Se escribe mediante un archivo temporal y reemplazo atómico, con permisos privados en sistemas que los soportan. **Exportar** descarga una copia JSON de la planificación activa; no se incluye una función de restauración desde la interfaz. Para una copia íntegra, conserva el archivo de trabajo con la aplicación detenida.

Los cambios locales tienen una versión para impedir sobrescrituras desde ventanas desactualizadas. La revisión compara cada campo editado con su valor importado y el remoto: conserva cambios remotos ajenos al borrador y señala los conflictos en el mismo campo. Elegir **Conservar versión de Azure** descarta todos los cambios locales de esa tarea; **Mantener mis cambios** los vuelve a preparar sobre la última versión leída. Ambas opciones requieren una nueva revisión.

Antes de escribir se comprueban otra vez todas las revisiones; cada actualización también incluye el `test /rev` atómico. La sincronización no es una transacción entre tareas: cada éxito se guarda por separado, los fallos permanecen pendientes y una revisión posterior reconoce los valores ya aplicados sin repetir escrituras. No hay reintentos automáticos de escrituras inciertas.

El servidor escucha exclusivamente en `127.0.0.1`, valida Host y Origin y requiere un token de sesión para las peticiones de modificación. No se debe exponer a Internet. Para cambiar el puerto o el directorio de datos se pueden usar `NEO_TEAM_PORT` y `NEO_TEAM_DATA_DIR`. Ejecuta una sola instancia por directorio de datos.

## Verificación

```sh
npm run check
npm test
```

Las pruebas cubren persistencia, aislamiento del ejemplo, validación del borrador, capacidad/calendarios, conflictos, revisiones concurrentes, sincronización parcial, recuperación de confirmaciones inciertas, protección HTTP y los contratos del MCP. Se comprueba el arranque real del MCP y sus esquemas sin autenticarse. Las operaciones contra Azure se prueban con respuestas controladas: **la conexión y sincronización con una organización real requieren configurarla e iniciar sesión desde la aplicación y no se han verificado en esta entrega**.

La interfaz incluye herramientas WebMCP opcionales para leer el plan y preparar borradores cuando el navegador las soporte. No permiten sincronizar directamente. No se ha realizado validación en un navegador con WebMCP ni pruebas visuales de navegador.

### Creaciones y cambios pendientes

Usa **+ Crear** o el **+** de una rama para crear épicas, features, historias, tareas y bugs en local. Los elementos nuevos y editados se señalan como pendientes; el paso 6 muestra el total. Los títulos también se pueden editar. Las creaciones se envían después de revisar, con los padres antes que los hijos.

Cada creación incluye una etiqueta técnica única `neo-create-…` que permite recuperar su resultado sin duplicar elementos si se pierde la respuesta. Se valida en Azure antes de enviar. Una creación enviada con resultado incierto no se reenvía ni se descarta automáticamente: la siguiente revisión y sincronización intentan localizarla. Si sigue sin aparecer o difiere del borrador, se conserva bloqueada para comprobarla en Azure. No elimines esta etiqueta mientras se recupera una creación incierta.

Los cambios existentes comparan los valores originales, locales y remotos. Un conflicto requiere elegir una versión; las escrituras comprueban además `/rev` de forma atómica. Un cambio remoto después de revisar detiene la sincronización. Los fallos parciales conservan los elementos pendientes. El reparto compartido de ramas y las confirmaciones personales son locales; las asignaciones de responsable sí se envían a Azure.

La creación real depende de los tipos y campos habilitados en el proceso del proyecto. Se han probado los contratos MCP y escenarios de error con datos controlados; no se ha creado ningún elemento en una organización real durante el desarrollo.
