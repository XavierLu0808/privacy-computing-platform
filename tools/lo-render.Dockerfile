# 渲染 docx 用的镜像：LibreOffice Writer + python-uno + 中文字体 + poppler
# 构建：docker build -t lo-render -f tools/lo-render.Dockerfile tools/
FROM ubuntu:latest
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libreoffice-writer python3-uno fonts-noto-cjk fonts-arphic-uming fonts-liberation poppler-utils \
    && rm -rf /var/lib/apt/lists/*
