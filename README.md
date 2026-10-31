# Examena · despliegue gratuito en Cloudflare

La plataforma usa GitHub como repositorio y Cloudflare Pages Functions + D1 Free para servir la web, ejecutar la API y guardar datos. GitHub Pages no ejecuta Functions; el portal para candidatos será la URL `*.pages.dev` que asigne Cloudflare. No hay correo de resultados en esta primera fase.

## Preparación local

- Pages Functions atiende las rutas `/api/*` en `functions/api/[[path]].js`.
- D1 crea su esquema y carga el examen en el primer acceso.
- El primer superadministrador y las claves objetivas se configuran como secretos de Pages. El archivo `.dev.vars` local conserva las claves del examen y está excluido de Git.
- No subas `.dev.vars`, `.env` ni archivos de respaldo al repositorio.

## Configurar Cloudflare en el plan Free

1. Crea una cuenta gratuita de Cloudflare.
2. Ve a **Workers & Pages → Create application → Pages → Connect to Git** y autoriza el repositorio `maroca87/examenes`.
3. Configura el comando de build `node build-site.mjs` y el directorio de salida `dist`. Cloudflare detectará la carpeta `functions/` en la raíz; los archivos antiguos de Node/PostgreSQL quedarán fuera del sitio público.
   `wrangler.jsonc` se conserva para desarrollo local. No agregues `pages_build_output_dir` mientras los bindings D1 y los secretos de producción se administren desde el panel de Cloudflare; al incluir esa propiedad, Wrangler pasa a ser la fuente de configuración de Pages.
4. Crea una base D1 gratuita con el nombre `examena`.
5. En el proyecto Pages, abre **Settings → Functions → D1 database bindings** y agrega el binding `DB` apuntando a `examena` (en producción y preview si se usan ambos).
6. En **Settings → Variables and Secrets**, agrega `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD` (12–128 caracteres), `SUPERADMIN_NAME` y `EXAM_ANSWER_KEYS`. Marca contraseñas y respuestas como secretos. Copia las respuestas desde la línea `EXAM_ANSWER_KEYS` del archivo local `.dev.vars`; no lo subas a GitHub.
7. Guarda y vuelve a desplegar. El primer acceso crea tablas, cuenta superadmin y borrador del examen.

El inicio de sesión no funcionará hasta que el binding `DB` y esos secretos estén configurados. No uses la URL de GitHub Pages para candidatos; usa la URL `pages.dev` del proyecto Cloudflare, que sirve interfaz y API desde el mismo origen.

## Cuotas y respaldos sin costo

Workers Free permite hasta 100.000 solicitudes al día. D1 Free incluye 5 millones de filas leídas y 100.000 escritas al día; una base individual puede crecer hasta 500 MB. Si se alcanzan límites gratuitos, las solicitudes de base de datos fallan hasta el reinicio de la cuota; no se requiere actualizar a un plan pagado. [Límites de Workers](https://developers.cloudflare.com/workers/platform/limits/) · [Límites de D1](https://developers.cloudflare.com/d1/platform/limits/) · [Cuotas gratuitas de D1](https://developers.cloudflare.com/d1/reference/faq/)

D1 conserva recuperación a un punto en el tiempo durante 7 días en el plan Free. La sección Respaldos permite exportar y restaurar una copia JSON manual; la recuperación automática se opera desde el panel de Cloudflare. Guarda exportaciones manuales fuera de GitHub y Cloudflare.

El informe final se genera como PDF al descargarlo, después de que el superadministrador libera el resultado. No se envían correos.

## Examen inicial

Se carga como borrador el examen de Soporte Nivel 2 · Impresión, con 59 preguntas: 35 de selección única, 10 verdadero/falso, 10 breves y 4 casos de desarrollo. El documento decía “3 casos” en el encabezado, pero incluía cuatro escenarios. El máximo es 73 puntos; cada respuesta abierta vale 0 Mejorable, 1 Bueno o 2 Muy Bueno. La duración inicial es 90 minutos y se puede editar.
