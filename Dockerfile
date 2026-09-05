FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    linux-headers-generic \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt pytest
COPY . .

# Docker is intended for validation and tests; screen input stays native to Windows.
ENTRYPOINT ["python", "main.py"]
CMD ["run"]
