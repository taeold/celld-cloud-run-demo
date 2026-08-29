FROM python:3.12-slim

WORKDIR /app

COPY index.html server.py ./

ENV PORT=8080
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["python3", "server.py"]
