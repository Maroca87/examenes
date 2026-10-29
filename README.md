# Examena · Plataforma de exámenes técnicos

Aplicación web con servidor Node.js y PostgreSQL. El cliente y la API se sirven desde el mismo origen; GitHub Pages por sí solo no puede ejecutar el backend. La estructura está preparada para desplegarse como servicio web y base PostgreSQL en Railway.

## Roles y reglas

- **Superadministrador:** control de usuarios y roles, exámenes, reportes, estadísticas, bitácora, respaldos, revisión y liberación de resultados.
- **Administrador:** crea y edita exámenes, asigna evaluaciones, administra candidatos y califica entregas; no puede borrar usuarios ni publicar el resultado al candidato.
- **Candidato:** accede a sus exámenes asignados, responde, entrega y descarga el informe cuando el superadministrador lo libera.
- Selección única y verdadero/falso: 1 punto por respuesta correcta.
- Respuesta breve y desarrollo: calificación manual de 0 **Mejorable**, 1 **Bueno** o 2 **Muy Bueno**.
- Los cambios a preguntas se bloquean después de que existan entregas; se debe duplicar el examen para conservar el historial.

## Ejecutar localmente

Requisitos: Node.js 20+ y PostgreSQL.

1. Crea una base PostgreSQL y copia `.env.example` a `.env`.
2. Configura `DATABASE_URL`, `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD` (entre 12 y 128 caracteres) y `SUPERADMIN_NAME`.
3. Ejecuta `npm install` y luego `npm start`.
4. Abre `http://localhost:3000`. En el primer inicio se ejecutan las migraciones y se crea el superadministrador inicial.

No subas `.env` ni la carpeta `data/` al repositorio.

## Despliegue en Railway

1. Crea un servicio desde tu repositorio y agrega el plugin/servicio PostgreSQL.
2. En el servicio web configura `DATABASE_URL` como referencia a la variable `DATABASE_URL` del servicio PostgreSQL, además de `NODE_ENV=production`, `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD` (entre 12 y 128 caracteres) y `SUPERADMIN_NAME`.
3. Agrega un volumen al servicio web montado en `/data` y configura `BACKUP_DIR=/data/backups` y `BACKUP_KEEP_DAYS=30`.
4. Railway ejecutará `npm start`; al iniciar se aplican las migraciones y se crea la primera cuenta superadmin.

Mantén el gasto mensual dentro del límite de facturación elegido en Railway. Los respaldos de aplicación viven en el volumen configurado; para recuperación ante pérdida de la cuenta/infraestructura, descarga periódicamente copias fuera de Railway.

## Examen inicial

En el primer inicio, el sistema carga como borrador **Examen Técnico de Soporte Nivel 2 · Impresión** con 59 preguntas y sus respuestas objetivas: 35 de selección única, 10 de verdadero/falso, 10 de respuesta breve y 4 casos de desarrollo. La duración inicial quedó en 90 minutos y es editable. El documento fuente indica “3 casos” en el encabezado, pero contiene cuatro escenarios y se conservaron los cuatro. La calificación máxima es 73 puntos (45 objetivos y 28 abiertos); cada respuesta breve y cada caso se califica con hasta 2 puntos.

La carga se registra una sola vez en la base de datos. El superadministrador o administrador puede revisar y editar el borrador y publicarlo cuando esté listo.
