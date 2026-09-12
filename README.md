# Neo Team

Aplicación local para preparar iteraciones y sincronizar los cambios con Azure DevOps a través de MCP. La organización, el proyecto, el equipo y el método de acceso se configuran desde la interfaz.

## Arranque

Requiere Node.js 22 o superior.

```sh
npm install
npm start
```

Abre **http://127.0.0.1:4310**. Para desarrollar, `npm run dev` reinicia el servidor al editarlo. No hay compilación de frontend: los archivos de `dist/` son las fuentes estáticas de la interfaz.

## Uso

1. En **Conectar Azure DevOps**, introduce tu organización o su URL.
2. Elige **Iniciar sesión con Microsoft**. **Buscar proyectos** abre el acceso de Microsoft cuando sea necesario y carga las opciones del campo. Puedes escribir los nombres directamente. **Buscar equipos** carga los equipos del proyecto indicado.
3. Pulsa **Conectar e importar**. También puedes guardar la configuración sin conectar. El modo **Azure CLI** utiliza una sesión previamente autenticada; el tenant de Entra es opcional.
4. En **1 · Capacidad**, revisa y ajusta las horas por día y los días libres de cada persona en la iteración seleccionada, además de los días libres comunes del equipo. Cada cambio se guarda en local, recalcula al instante las horas disponibles del paso 3 y se envía a Azure DevOps al sincronizar. Los días libres deben estar dentro de la iteración y no pueden solaparse entre sí.
5. En **2 · Repartir ramas**, abre el desplegable de personas de una Epic, Feature, User Story o tarea. Busca nombres y marca o desmarca sus casillas. El reparto se guarda al instante en local y se hereda a los descendientes.
6. En **3 · Elegir tareas**, navega por las tarjetas de personas. Cada una muestra sus horas, una barra de carga y si queda margen, están cubiertas o se ha superado la capacidad. Si faltan estimaciones o capacidad, el indicador lo señala. Quienes tienen las horas cubiertas o excedidas aparecen al final. Con las tareas estimadas, su botón **Confirmar** marca el reparto como revisado en esta iteración; se guarda en local y se invalida si cambian sus tareas, horas o capacidad.
7. Marca las tareas y bugs que corresponden a la persona en la iteración. **La casilla refleja el plan guardado**: no hay botón de añadir ni selección pendiente de confirmar. Desmarcar deja la tarea sin responsable y la devuelve al backlog, conservando sus demás cambios. Las seleccionadas permanecen visibles para poder quitarlas; las que tienen otro responsable están ocultas por defecto.
8. **Quitar rama** permite retirar un bloque completo desde el paso 3. Retira la participación de esa persona en el bloque y sus descendientes, y desmarca sus tareas de la iteración actual. Conserva los demás participantes y no modifica las asignaciones de otras iteraciones. Se puede volver a incluir una subrama expresamente desde el paso 2. Reincorporar una rama no vuelve a seleccionar sus tareas automáticamente.
9. **4 · Revisar** compara el borrador (tareas y capacidad) con Azure DevOps y permite confirmar la sincronización. Si la capacidad ha cambiado en Azure desde la importación, la revisión lo señala como conflicto y ofrece conservar la versión de Azure o mantener la tuya. Los desplegables y casillas anteriores nunca escriben directamente en Azure.

**Más opciones (···)** permite consultar la vista del equipo, todas las tareas, actualizar datos, exportar o descartar cambios. La configuración está en la cabecera.

**Probar con un ejemplo** ofrece un espacio separado. Su sincronización es una simulación local y nunca contacta con Azure DevOps. Puedes entrar y salir conservando ambos borradores.

## Qué importa y sincroniza

- Recupera también los padres que no estén en los niveles visibles o áreas del equipo como contexto, sin recorrer sus tareas hermanas ni permitir escrituras remotas sobre esos padres.
- Importa integrantes completos del equipo, sus iteraciones, los niveles del backlog, los work items de cada iteración y las tareas hijas accesibles dentro de las áreas del equipo.
- Sólo guarda elementos abiertos: consulta las categorías de estado de cada tipo y excluye `Completed` y `Removed`, incluidos los estados personalizados y los padres cerrados. Conserva las tareas hijas abiertas y los elementos `Resolved` pendientes de validación. El progreso indica cuántos se han excluido; al actualizar los datos también desaparecen de la copia local los que se hayan cerrado desde la importación anterior.
- Consulta capacidad, calendario laboral, ausencias personales y días libres del equipo. Una capacidad que no se ha podido consultar se muestra como desconocida, acompañada de un aviso.
- Mantiene las estimaciones en puntos separadas de las horas. La carga utiliza **RemainingWork**; los puntos se muestran como información. No se convierten puntos a horas.
- Sincroniza únicamente los campos editados: `System.AssignedTo`, `System.IterationPath`, `Microsoft.VSTS.Common.Priority` y `Microsoft.VSTS.Scheduling.RemainingWork`.
- Las tarjetas se ordenan por prioridad e identificador. Mover una tarjeta cambia su asignación e iteración; no escribe el orden de Azure (`StackRank`). El reparto de participantes no crea cambios remotos en los padres. Solo las tareas y bugs elegidos pasan al borrador de la iteración.
- Esta versión no crea ni elimina work items ni modifica capacidades, estados, fechas de iteración o relaciones. **Actualizar datos** requiere sincronizar o descartar el borrador previo.
- La importación excluye las iteraciones pasadas antes de consultar sus tareas y capacidades. Mantiene la actual, las futuras y las que no tienen fechas suficientes para clasificarlas; el progreso indica cuántas anteriores se han excluido. Recorre las tareas sin un límite silencioso. Un fallo de importación conserva la copia anterior.

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

Usa **+ Crear** o el **+** de una rama para crear épicas, features, historias, tareas y bugs en local. Los elementos nuevos y editados se señalan como pendientes; el paso 4 muestra el total. Los títulos también se pueden editar. Las creaciones se envían después de revisar, con los padres antes que los hijos.

Cada creación incluye una etiqueta técnica única `neo-create-…` que permite recuperar su resultado sin duplicar elementos si se pierde la respuesta. Se valida en Azure antes de enviar. Una creación enviada con resultado incierto no se reenvía ni se descarta automáticamente: la siguiente revisión y sincronización intentan localizarla. Si sigue sin aparecer o difiere del borrador, se conserva bloqueada para comprobarla en Azure. No elimines esta etiqueta mientras se recupera una creación incierta.

Los cambios existentes comparan los valores originales, locales y remotos. Un conflicto requiere elegir una versión; las escrituras comprueban además `/rev` de forma atómica. Un cambio remoto después de revisar detiene la sincronización. Los fallos parciales conservan los elementos pendientes. El reparto compartido de ramas y las confirmaciones personales son locales; las asignaciones de responsable sí se envían a Azure.

La creación real depende de los tipos y campos habilitados en el proceso del proyecto. Se han probado los contratos MCP y escenarios de error con datos controlados; no se ha creado ningún elemento en una organización real durante el desarrollo.
