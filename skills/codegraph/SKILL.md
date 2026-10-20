---
name: codegraph
description: Use the local `codegraph` binary to understand or navigate code in a repository that has a `.codegraph/` index. Prefer it over grep/find/read_file when locating symbols, tracing call paths, or reading source by symbol name.
---

# CodeGraph

En repositorios indexados por CodeGraph (existe un directorio `.codegraph/` en la raíz del repo), prefiere las herramientas de CodeGraph **antes** que `grep`, `find` o leer archivos completos cuando necesites entender o localizar código.

## Cuándo usar CodeGraph

Úsalo cuando la pregunta sea sobre **estructura, símbolos o flujo de ejecución**:

- Localizar dónde se define una función, clase, método o variable.
- Seguir la cadena de llamadas entre funciones (callers / callees).
- Leer la fuente de un símbolo específico (con sus llamadas entrantes y salientes).
- Entender qué archivos o símbolos se ven afectados por cambiar uno concreto (análisis de impacto).
- Construir contexto para una tarea de programación (símbolos relevantes + bloques de código).

**No lo uses** si:

- No existe `.codegraph/` en la raíz del workspace (CodeGraph no está inicializado).
- La pregunta es trivial (una constante, una cadena, una ruta obvia en un archivo que ya conoces).
- Necesitas contenido textual plano (comentarios, docstrings, cadenas concretas) — ahí `read_file` con `grep` sigue siendo mejor.

## Interfaz disponible

CodeGraph expone un binario CLI en `~/.npm-global/bin/codegraph` (ya en el PATH). MinAgent no tiene una herramienta MCP `codegraph_explore`, pero **sí puede invocar `codegraph` desde `run_terminal`**, así que ese es el canal real.

Comandos clave (sintaxis verificada con `codegraph --help`):

| Comando | Para qué sirve |
|---|---|
| `codegraph explore "<query>"` | Punto de entrada por defecto. Devuelve los símbolos relevantes con su fuente verbatim + los caminos de llamada entre ellos (incluye saltos de despacho dinámico que `grep` no puede seguir). Nombra un archivo o símbolo en la consulta para leer su fuente con números de línea. |
| `codegraph node "<nombre>"` | Fuente de **un** símbolo + su cadena caller/callee. Equivale a la herramienta MCP `codegraph_node`. Si está diferido, cárgalo por nombre. |
| `codegraph node --file <archivo>` | Lee un archivo con números de línea + sus dependientes. Usa `--offset` y `--limit` para porciones; `--symbols-only` para solo el mapa de símbolos. |
| `codegraph callers <símbolo>` | Todas las funciones/métodos que llaman a un símbolo. |
| `codegraph callees <símbolo>` | Todas las funciones/métodos llamados por un símbolo. |
| `codegraph impact <símbolo>` | Qué código se ve afectado al modificar un símbolo. |
| `codegraph context "<tarea>"` | Construye contexto para una tarea: símbolos relevantes, relaciones y bloques de código. |
| `codegraph query <búsqueda>` | Búsqueda de símbolos en el codebase. |
| `codegraph files` | Estructura de archivos del proyecto según el índice. |
| `codegraph status` | Estado del índice y estadísticas. |
| `codegraph sync` | Sincroniza cambios desde el último índice (no reconstruir entero). |
| `codegraph index` | Reconstruye el índice desde cero (más caro que `sync`). |

## Procedimiento

1. **Detecta** si el workspace contiene un directorio `.codegraph/`. Si no existe, no inventes resultados, di "CodeGraph no está inicializado en este repo" y sugiere `codegraph init [path]`.
2. **Empieza por `explore`** salvo que sepas exactamente qué símbolo quieres: `codegraph explore "cómo se resuelve la autenticación"` o `codegraph explore "AuthService"` para leer ese símbolo concreto.
3. Si el resultado lista símbolos diferidos (deferred), **cárgalos por nombre** con `codegraph node <nombre>` (o `codegraph explore <nombre>`).
4. Para leer un archivo concreto con números de línea y ver sus dependientes: `codegraph node --file <ruta>`.
6. **Antes de modificar código**, ejecuta `codegraph impact <símbolo>` para ver qué se rompe.
7. Si el índice está desactualizado (archivos cambiados no reflejados), usa `codegraph sync`. Solo usa `codegraph index` (rebuild completo) si `sync` no basta.

## Convenciones

- **Pasa siempre una descripción clara y detallada** de la tarea en `explore` / `context` — son los comandos que más se benefician de consultas bien redactadas.
- **Especifica el directorio de trabajo** si es distinto al actual: `codegraph -p /ruta/al/proyecto explore "..."`. Si omites `-p`, codegraph asume el CWD.
- **No delegues tareas simples** que puedas resolver tú mismo con un `read_file` rápido.
- **Evita volcar el código completo de un archivo** si solo necesitas la definición de un símbolo: `codegraph node <símbolo>` es más eficiente que `read_file`.

## Errores comunes (a evitar)

- ❌ Usar `grep -r "nombre"` cuando existe `.codegraph/` → pierde despacho dinámico y dependencias indirectas.
- ❌ Llamar a `codegraph explore` sin comillas o con la consulta vacía → error de sintaxis.
- ❌ Reconstruir el índice completo (`codegraph index`) cuando basta con `codegraph sync` → innecesariamente lento.
- ❌ Inventar el resultado si `.codegraph/` no existe → primero `codegraph init [path]`.
- ❌ Confundir `codegraph node <símbolo>` (un símbolo) con `codegraph node --file <archivo>` (lectura de archivo). Son modos distintos.

## Verificación

Antes de dar una respuesta basada en CodeGraph, confirma que:

1. El comando salió con código 0 y devolvió contenido.
2. La fuente mostrada corresponde al símbolo o archivo que preguntaron (verifica el nombre/encabezado).
3. Si mencionas "no se llama desde ningún sitio" o "no llama a nada", asegúrate de haber comprobado `callers` y `calees`, no solo `explore`.