FROM flyway/flyway:11
COPY db/migrations /flyway/sql
COPY db/callbacks /flyway/callbacks
ENV FLYWAY_LOCATIONS=filesystem:/flyway/sql,filesystem:/flyway/callbacks
CMD ["migrate"]
