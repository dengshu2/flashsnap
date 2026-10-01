FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/flashsnap .

# Headless Chrome renders the cards.
FROM chromedp/headless-shell:latest
# The fonts the prompt lets cards use, under the same family names Google Fonts
# serves to the live preview, so preview and image match and rendering never
# waits on the network.
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf /usr/share/fonts/truetype/cards/NotoSansSC.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf /usr/share/fonts/truetype/cards/NotoSerifSC.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf /usr/share/fonts/truetype/cards/Inter.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf /usr/share/fonts/truetype/cards/Oswald.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf /usr/share/fonts/truetype/cards/PlayfairDisplay.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf /usr/share/fonts/truetype/cards/JetBrainsMono.ttf
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && chmod 644 /usr/share/fonts/truetype/cards/*.ttf \
 && fc-cache -f \
 && useradd --uid 1001 --create-home app \
 && mkdir -p /app/data && chown app /app/data
COPY --from=build /out/flashsnap /app/flashsnap
USER app
ENV CHROME_PATH=/headless-shell/headless-shell DATA_DIR=/app/data PORT=8080 TZ=Asia/Shanghai
EXPOSE 8080
ENTRYPOINT ["/app/flashsnap"]
