def use_conjur_sidecar(framework):
    use_conjur = False

    if framework:
        name = get_val(framework, "name")
        version = get_val(framework, "version")

        if name == "stargate":
            versions = version.split(".")
            major_ver = int(versions[0]) if len(versions) > 0 else 0
            minor_ver = int(versions[1]) if len(versions) > 1 else 0
            if (major_ver == 2 and minor_ver != 6) or (major_ver == 3 and minor_ver < 3):
                use_conjur = True

    return use_conjur

