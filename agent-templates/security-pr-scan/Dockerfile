FROM node:22-slim

# Security scanning tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# semgrep (pinned)
RUN pip3 install --no-cache-dir --break-system-packages semgrep==1.72.0

# gitleaks (pinned)
RUN curl -sSL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_$(dpkg --print-architecture).tar.gz \
    | tar -xz -C /usr/local/bin gitleaks

WORKDIR /app
# Build context is repo root — copy from harness subdirectory
COPY harnesses/claude-agent-sdk/package*.json ./
COPY harnesses/claude-agent-sdk/package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps

COPY harnesses/claude-agent-sdk/dist/ ./dist/

ENV PORT=4096
EXPOSE 4096

CMD ["node", "dist/server.js"]
