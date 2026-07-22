# OpenShift Deployment

These manifests deploy the `releaselogs` web app with:

- `config.yaml` embedded in the `releaselogs-config` ConfigMap
- ephemeral runtime data on an `emptyDir`
- ephemeral S3 download cache on an `emptyDir`
- a Service exposing HTTP and HTTPS container ports
- an OpenShift Route using edge TLS termination

Deploy:

```sh
oc apply -f openshift/configmap.yaml
oc apply -f openshift/deployment.yaml
oc apply -f openshift/service.yaml
oc apply -f openshift/route.yaml
```

Set your image before deploying, or patch it afterward:

```sh
oc set image deployment/releaselogs releaselogs=<registry>/<namespace>/releaselogs:<tag>
```

The ConfigMap is mounted read-only at `/app/config/config.yaml`, and the container uses `CONFIG_PATH=/app/config/config.yaml`. Runtime data such as local users is stored on an ephemeral `/app/data` volume.

Because OpenShift ConfigMap volumes are read-only, configuration changes should be made by updating `openshift/configmap.yaml`, re-applying it, then restarting the deployment.

The included ConfigMap config is intentionally sanitized. Put the OpenShift service names, credentials, and index names for your cluster there before applying.
