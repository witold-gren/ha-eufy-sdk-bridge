# The official eufy-sdk bridge add-on, plus the bridge files changed in the witold-gren/ha-eufy-sdk-bridge
# fork (copied into bridge/ by deploy.sh). `BUILD_FROM` comes from build.yaml: the bridge release the fork
# is based on, so only the patched files differ.
ARG BUILD_FROM=ghcr.io/mega-yfue/ha-eufy-sdk-bridge:0.7.2
FROM ${BUILD_FROM}

RUN apk add --no-cache curl jq

COPY bridge/streams.mjs /app/streams.mjs
# server.mjs z forka: podłącza rejestrator podglądu (live-recorder.mjs)
COPY bridge/server.mjs /app/server.mjs
# go2rtc.yaml z dodatkowym źródłem dźwięku /audio/<sn> (fork: live audio)
COPY bridge/go2rtc-config.mjs /app/go2rtc-config.mjs
COPY bridge/src/ /app/src/
# SDK 0.5.0 z łatką z gałęzi local/sd-download klonu eufy-sdk: kamera, która sama jest stacją, pobiera nagranie
# z karty po ścieżce z bazy (`downloadRecording({ path })`), potrzebne do nagrań z karty (sd-card.mjs)
COPY sdk/index.js /app/node_modules/@mega-yfue/eufy-sdk/dist/index.js

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD [ "/run.sh" ]
