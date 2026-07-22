FROM alpine:3.20

RUN apk add --no-cache openldap openldap-back-mdb openldap-clients

COPY slapd.conf.template /etc/openldap/slapd.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 389 636

ENTRYPOINT ["/entrypoint.sh"]
