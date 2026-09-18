# Version verified against keycloak.org/downloads on 2026-09-15.
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4
# The relative paths are build-time options: `start --optimized` refuses to
# apply them at runtime, so they must be baked in here and match compose.
ARG KC_RELATIVE_PATH=/id
FROM ${KEYCLOAK_IMAGE} AS builder
ARG KC_RELATIVE_PATH
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=${KC_RELATIVE_PATH} KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
RUN /opt/keycloak/bin/kc.sh build
FROM ${KEYCLOAK_IMAGE}
ARG KC_RELATIVE_PATH
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=${KC_RELATIVE_PATH} KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
USER 1000:0
ENTRYPOINT ["/bin/bash", "/opt/subrosa/keycloak-start.sh"]
