#!/usr/bin/env bash

set -e

APP_DIR="$HOME/Desktop/playground/ai-ingestion-platform"
POSTGRES_DIR="$HOME/Desktop/local-infra/postgres"
REDIS_DIR="$HOME/Desktop/local-infra/redis"

CLOUDFLARED_CONFIG="$HOME/.cloudflared/config.yml"
CLOUDFLARED_PID_FILE="/tmp/ai-app-cloudflared.pid"

start() {
    echo "Starting PostgreSQL..."
    docker compose -f "$POSTGRES_DIR/docker-compose.yml" up -d

    echo "Starting Redis..."
    docker compose -f "$REDIS_DIR/docker-compose.yml" up -d

    echo "Starting Application..."
    docker compose -f "$APP_DIR/docker-compose.yml" up -d

    if [[ -f "$CLOUDFLARED_PID_FILE" ]] && kill -0 "$(cat "$CLOUDFLARED_PID_FILE")" 2>/dev/null; then
        echo "Cloudflared is already running."
    else
        echo "Starting Cloudflared Tunnel..."
        nohup cloudflared tunnel \
            --config "$CLOUDFLARED_CONFIG" \
            run > /tmp/cloudflared.log 2>&1 &

        echo $! > "$CLOUDFLARED_PID_FILE"
    fi

    echo "Application started."
}

stop() {
    echo "Stopping Application..."
    docker compose -f "$APP_DIR/docker-compose.yml" down

    echo "Stopping Redis..."
    docker compose -f "$REDIS_DIR/docker-compose.yml" down

    echo "Stopping PostgreSQL..."
    docker compose -f "$POSTGRES_DIR/docker-compose.yml" down

    if [[ -f "$CLOUDFLARED_PID_FILE" ]]; then
        PID=$(cat "$CLOUDFLARED_PID_FILE")

        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping Cloudflared Tunnel..."
            kill "$PID"
        fi

        rm -f "$CLOUDFLARED_PID_FILE"
    else
        echo "Cloudflared is not running."
    fi

    echo "Application stopped."
}

restart() {
    stop
    start
}

status() {
    echo "Docker Containers:"
    docker ps

    echo

    if [[ -f "$CLOUDFLARED_PID_FILE" ]] && kill -0 "$(cat "$CLOUDFLARED_PID_FILE")" 2>/dev/null; then
        echo "Cloudflared: Running (PID $(cat "$CLOUDFLARED_PID_FILE"))"
    else
        echo "Cloudflared: Not running"
    fi
}

case "$1" in
    start) start ;;
    stop) stop ;;
    restart) restart ;;
    status) status ;;
    *)
        echo "Usage: ai-app {start|stop|restart|status}"
        exit 1
        ;;
esac