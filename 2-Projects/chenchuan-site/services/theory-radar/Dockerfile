FROM python:3.12-alpine@sha256:aa679aa4eed6eb56c1dc6ad3f1b98b7d2d788fd961596779d188fdedad97fb38

RUN addgroup -g 10001 radar && adduser -D -H -u 10001 -G radar radar
WORKDIR /app
COPY --chown=radar:radar theory_radar.py /app/theory_radar.py
USER 10001:10001
ENTRYPOINT ["python", "/app/theory_radar.py"]
CMD ["run"]
