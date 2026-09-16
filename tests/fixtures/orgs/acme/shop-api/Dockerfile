FROM python:3.11-slim
WORKDIR /srv
COPY . .
ENV DATABASE_URL=""
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]
