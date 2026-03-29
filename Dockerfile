FROM denoland/deno:latest

# Install curl for TLS fingerprint bypass
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy source files
COPY main.ts .
COPY deno.json .

# Cache dependencies
RUN deno cache main.ts

# Expose port 8000 (default Deno serve port)
EXPOSE 8000

# Run the proxy server
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "main.ts"]
