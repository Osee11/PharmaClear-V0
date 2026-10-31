# Deployment

The Docker image runs the Node.js application and the C relay in one
non-root container. Node listens on `PORT` (default `3000`); the relay listens
only on `127.0.0.1:8080`. The Node health endpoint is
`GET /api/health`. HTTPS must terminate at the hosting provider's trusted
proxy/load balancer; do not expose the C relay port publicly.

The image contains no API key or access tokens. Set every secret through the
hosting provider's runtime environment-variable settings:

| Variable | Purpose |
|---|---|
| `MODEL_API_KEY` | Meta API key. Omit only when intentionally using simulation. |
| `DEMO_ACCESS_CODE` | Optional code required for patient-facing access. |
| `RELAY_TOKEN` or `PHARMA_TOKEN` | Node-to-C relay credential; the entrypoint maps either name to both processes. |
| `INTERNAL_RELAY_TOKEN` or `PHARMA_NODE_TOKEN` | C-to-Node internal credential; the entrypoint maps either name to both processes. Use a random URL-safe value of 16–128 characters. |

Do not put secrets in Docker build arguments, the Dockerfile, source control,
or a public URL. Use separate random values for the relay credential and
internal relay credential. Other optional runtime settings include
`DAILY_ANALYSIS_LIMIT`, `API_RATE_LIMIT`, `FON_MT`, `TRUST_PROXY`,
`CORS_ORIGIN`, and `PHARMA_MOCK`.

## Render

1. Push the project to a private Git repository. Confirm `.env`, uploaded
   images, runtime state, and evaluation images are not in the repository.
2. In Render, choose **New → Web Service**, connect the repository, and select
   **Docker** as the runtime. Use the project root as the Docker build context
   and `Dockerfile` as the Dockerfile path.
3. Create the web service. Render supplies `PORT`; the container uses it for
   Node and points the C relay to that Node port automatically.
4. In the service's **Environment** settings, add `MODEL_API_KEY` and
   `DEMO_ACCESS_CODE`, and set the relay tokens if the relay is used. Add
   optional quota and proxy settings as appropriate. Never add secrets as
   Docker build arguments.
5. Deploy and wait for the service health check to pass. Verify the generated
   HTTPS URL serves the app and that `/api/health` returns JSON with `ok: true`.
6. Confirm the demo access code and upload flow using only synthetic images.
   The relay is loopback-only inside the container; Render's public service
   exposes Node, not the C port.

Render's default filesystem is ephemeral. In particular, the daily-analysis
counter in `runtime/` is **not persistent**: it resets when the container is
replaced or restarted, so it is not a durable global daily quota. A Render
persistent disk can preserve local files where supported, but it is tied to a
service instance and may affect scaling/deploy behavior; use a shared external
store for a reliable quota across instances. The relay's queue and results are
also local files and are lost with an ephemeral container.

## Railway

Railway can build the same Dockerfile from the repository root. Create a
service from the repository, configure the same runtime variables in the
service's Variables panel, and use Railway's generated HTTPS domain. Railway
provides a runtime port through `PORT`, which the image already honors; set
the service health-check path to `/api/health` if configuring one in the
Railway dashboard. Add a Railway volume mounted at `/app/runtime` only if
preserving the counter across restarts of that instance is desired. A local
volume is not shared between replicas and does not create a durable quota
across multiple instances.

## VPS

Install Docker Engine and the Compose plugin, clone the repository, and build
from its root:

```sh
docker build -t pharmaclear .
```

Run behind a TLS-terminating reverse proxy (for example, Caddy or Nginx).
Pass secrets at runtime using a protected environment file outside the
repository or the VPS's secret manager; do not bake them into the image.
Publish only the Node port, and bind it to loopback if the proxy is on the
same host:

```sh
docker run -d --name pharmaclear \
  --restart unless-stopped \
  --env-file /etc/pharmaclear/pharmaclear.env \
  -e PORT=3000 \
  -p 127.0.0.1:3000:3000 \
  -v pharmaclear-runtime:/app/runtime \
  -v pharmaclear-uploads:/app/uploads \
  pharmaclear
```

For persistent C queue/result files, mount only those directories individually
(`/app/serveur_c/queue`, `/app/serveur_c/done`, and
`/app/serveur_c/results`); mounting over `/app/serveur_c` would mask the
compiled relay binary. Ensure mounted directories are writable by the
container's non-root `node` user (UID 1000). The daily counter is stored in
`/app/runtime/daily-analysis-usage.json`; without a persistent volume it resets
when the container is replaced. A single local volume still does not provide a
shared quota across multiple containers.

Set `TRUST_PROXY` only to the actual trusted reverse-proxy address/range, and
configure the proxy to forward the original client address correctly. Do not
trust arbitrary forwarded headers. Keep the relay bound to `127.0.0.1`; do not
publish port 8080.

## Local Docker smoke test

Build and run without an API key to use the explicitly simulated mode:

```sh
docker build -t pharmaclear .
docker run --rm --name pharmaclear -p 3000:3000 \
  -e PHARMA_MOCK=1 pharmaclear
```

In another terminal, confirm the endpoint and then stop the container with
Ctrl-C:

```sh
curl --fail http://127.0.0.1:3000/api/health
```

For a real API test, pass `MODEL_API_KEY` securely at runtime and use only
synthetic prescription images. A successful health check confirms the Node
process is reachable; the container entrypoint also stops the container if
either Node or the C relay exits.
