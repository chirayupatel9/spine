FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Run as an ordinary user, not root. docker-compose.yml sets the IDs (PUID/PGID) to match the
# owner of your ./data folder.
RUN useradd --system --uid 1000 --home-dir /srv --shell /usr/sbin/nologin albumviewer \
 && mkdir -p /data && chown albumviewer /data
COPY app ./app
COPY web ./web

ENV MUSIC_DIR=/music DATA_DIR=/data
VOLUME ["/data"]
USER albumviewer
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status != 200)"
# Which commit this is (deploy/bad-omen/autodeploy.sh passes it in); /healthz reports it. Last, so
# a new value only rebuilds this tiny layer.
ARG VERSION=dev
ENV ALBUM_VIEWER_VERSION=$VERSION
# Proxy headers are trusted only from FORWARDED_ALLOW_IPS (default 127.0.0.1). Set it to your
# reverse proxy's address so sign-in limits see real client addresses.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
