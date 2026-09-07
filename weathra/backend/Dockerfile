# Weathra — the production backend image.
#
# Task 23.4. Render builds this file and runs the result; nothing else serves production traffic.
#
# ---------------------------------------------------------------------------------------------
# What this image deliberately does NOT contain
#
# **No credential, and no path by which one could arrive.** There is no `ARG` for a secret, no
# `ENV` holding one, and — the part that is easy to get wrong — the runtime stage copies *no source
# tree*. It copies the virtualenv the build stage produced, and the `weathra` package inside it was
# installed by pip. A `.env` sitting in a developer's working tree is excluded from the build
# context by `.dockerignore` and, even if that failed, would have nowhere to land here. Every
# secret arrives at run time from the Render service environment, which is what makes the image
# itself publishable.
#
# **No privileged database credential, ever.** This image serves browser requests, so it runs as
# `WEATHRA_RUNTIME_MODE=request_serving` (set by `render.yaml`) and `Settings` refuses to start if
# `SUPABASE_SERVICE_ROLE_KEY` is present. Migrations do not run here — not as a `CMD`, not as a
# Render pre-deploy command. They run in GitHub Actions under `DATABASE_URL_PRIVILEGED`, before
# this image is released. See `.github/workflows/release.yml`.
#
# ---------------------------------------------------------------------------------------------
# Reproducibility
#
# `pyproject.toml` declares floors (`fastapi>=0.115`), which is right for a library and wrong for
# an image: two builds of the same commit would install different versions, so a green CI run would
# not describe what production runs. `constraints.txt` pins the fully resolved set, and the install
# below is the only place dependencies enter. Regenerate it whenever `pyproject.toml` changes —
# `weathra/docs/deployment.md` records the command.
# ---------------------------------------------------------------------------------------------

# ------------------------------------------------------------------------------- build stage
FROM python:3.12-slim AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /src

# An isolated environment rather than the system interpreter, so the runtime stage can take the
# dependency tree as one directory and leave every build tool behind.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Only what the install needs. Copied before the source so a source-only change does not re-resolve
# the dependency tree.
COPY constraints.txt pyproject.toml ./
COPY weathra ./weathra

# `--no-deps` is deliberately NOT used: pip still resolves the graph, but `-c` forbids it from
# choosing any version other than the pinned one. A dependency added to `pyproject.toml` without a
# matching constraint therefore fails the build rather than silently floating.
RUN pip install --upgrade pip setuptools wheel \
 && pip install --constraint constraints.txt .

# ------------------------------------------------------------------------------- runtime stage
FROM python:3.12-slim AS runtime

# `libgomp1` is OpenMP, which `onnxruntime` links against — `fastembed` imports it to produce the
# BGE-small embeddings the RAG corpus is indexed with (design decision 8). Without it the import
# fails at the first retrieval rather than at start-up, which is the worst place to find out.
# `ca-certificates` is what makes outbound TLS work: Supabase, OpenRouter, Open-Meteo.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A non-root runtime user. Nothing in the serving path writes to the image, so the only directory
# that needs to be writable is the model cache below.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin weathra

COPY --from=build --chown=weathra:weathra /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # `fastembed` fetches the ONNX weights on first use and caches them. Both variables point at a
    # directory this user owns; left at their defaults they would resolve under a path a non-root
    # process cannot write, and the first retrieval would fail on a permission error.
    HF_HOME=/home/weathra/.cache/huggingface \
    FASTEMBED_CACHE_PATH=/home/weathra/.cache/fastembed

RUN mkdir -p /home/weathra/.cache/huggingface /home/weathra/.cache/fastembed \
 && chown -R weathra:weathra /home/weathra/.cache

USER weathra
WORKDIR /home/weathra

# Render assigns the port and passes it as `$PORT`; the fallback is Render's own default, so the
# image is also runnable with a bare `docker run -p 10000:10000`.
ENV PORT=10000
EXPOSE 10000

# Liveness only, matching `healthCheckPath` in `render.yaml`. `/health` depends on nothing, so a
# database blip does not cause a container to be killed and replaced. Written with `urllib` because
# the runtime stage carries no `curl`, and adding one to answer a health check is a package more
# than the image needs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen(f\"http://127.0.0.1:{os.environ['PORT']}/api/v1/health\", timeout=4).status == 200 else 1)"

# A shell is needed because `$PORT` is set by Render at run time and must expand; `exec` then
# replaces that shell, so uvicorn becomes PID 1 and receives Render's SIGTERM directly — which is
# what lets in-flight requests drain instead of being killed along with the shell. Written in JSON
# form rather than bare shell form so the intent is explicit and BuildKit does not warn about
# signal handling. `--factory` matches `create_app()` in `weathra/api/app.py`.
CMD ["sh", "-c", "exec uvicorn weathra.api.app:create_app --factory --host 0.0.0.0 --port \"$PORT\""]
