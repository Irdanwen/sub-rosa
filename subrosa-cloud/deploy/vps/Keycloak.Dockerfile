# Version verified against keycloak.org/downloads on 2026-09-15.
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4
FROM ${KEYCLOAK_IMAGE} AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build
FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
USER 1000:0
ENTRYPOINT ["/bin/bash", "/opt/subrosa/keycloak-start.sh"]
