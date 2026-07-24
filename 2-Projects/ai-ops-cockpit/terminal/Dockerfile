FROM tsl0922/ttyd:latest

ARG DOCKER_GID=988
ENV BUN_INSTALL=/opt/bun

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        docker.io \
        docker-compose-v2 \
        git \
        jq \
        less \
        nano \
        openssh-client \
        python3 \
        ripgrep \
        rsync \
        sudo \
        tmux \
        unzip \
        vim \
        wget \
    && groupadd -g ${DOCKER_GID} hostdocker || true \
    && useradd -m -s /bin/bash -G sudo,docker,hostdocker ops \
    && echo 'ops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ops-terminal \
    && chmod 0440 /etc/sudoers.d/90-ops-terminal \
    && mkdir -p /workspace /var/log/ops-terminal \
    && chown -R ops:ops /workspace /var/log/ops-terminal \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
    && /opt/bun/bin/bun add -g @oh-my-pi/pi-coding-agent@16.3.11 \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/omp /usr/local/bin/omp \
    && chmod -R a+rX /opt/bun

COPY vibe-shell /usr/local/bin/vibe-shell
COPY vibe-omp /usr/local/bin/vibe-omp
COPY omp-aiops /usr/local/bin/omp-aiops
COPY vibe-bashrc /etc/aiops-vibe-bashrc
COPY models.volcengine.yml /etc/aiops-models.yml
RUN chmod +x /usr/local/bin/vibe-shell /usr/local/bin/vibe-omp /usr/local/bin/omp-aiops \
    && echo 'if [ -f /etc/aiops-vibe-bashrc ]; then . /etc/aiops-vibe-bashrc; fi' >> /home/ops/.bashrc \
    && chown ops:ops /home/ops/.bashrc

USER ops
WORKDIR /workspace
ENV HOME=/home/ops
CMD ["ttyd", "--writable", "--base-path", "/terminal", "--terminal-type", "xterm-256color", "-t", "fontSize=14", "-t", "theme={\"background\":\"#020617\",\"foreground\":\"#e5e7eb\",\"cursor\":\"#38bdf8\"}", "/usr/local/bin/vibe-shell"]
