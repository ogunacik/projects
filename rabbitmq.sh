# Directories



openssl s_client -connect xray01:5671 -CAfile /apps/xray/var/data/server/certs/ca-cert.pem


openssl req -x509 -new -nodes -keyout ca-key.pem -out ca-cert.pem -days 3650 -config openssl_xray.conf -extensions v3_ca


# Create the CSR
openssl req -new -nodes -keyout server-key.pem -out server.csr -config openssl_xray.conf -subj "/CN=xray01"

# Sign it for 3650 days (10 years)
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
-out server-cert.pem -days 3650 -extensions v3_req -extfile openssl_xray.conf


# Create the CSR
openssl req -new -nodes -keyout client-key.pem -out client.csr -config openssl_xray.conf -subj "/CN=xray-client"

# Sign it for 3650 days (10 years)
openssl x509 -req -in client.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
-out client-cert.pem -days 3650 -extensions v3_req -extfile openssl_xray.conf



#-------------------------------------------------------------dpeloy certs----------------
RABBIT_DIR="/apps/xray/var/data/rabbitmq/certs"
SERVER_DIR="/apps/xray/var/data/server/certs"

mkdir -p $RABBIT_DIR $SERVER_DIR

# Copy to RabbitMQ (Needs CA, Server Cert, Server Key)
cp ca-cert.pem server-cert.pem server-key.pem $RABBIT_DIR/

# Copy to Xray Server (Needs CA, Client Cert, Client Key)
cp ca-cert.pem client-cert.pem client-key.pem $SERVER_DIR/

# Fix Permissions (Critical!)
chown -R xray:xray /apps/xray/var/data/
chmod 644 $RABBIT_DIR/*.pem $SERVER_DIR/*.pem
chmod 600 $RABBIT_DIR/server-key.pem $SERVER_DIR/client-key.pem
