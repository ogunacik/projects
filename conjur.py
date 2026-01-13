# Policy rules for Conjur sidecar injection
# Format: list of rules, each rule is a dict with:
#   - "major": major version to match
#   - "minor_op": operator for minor version ("eq", "ne", "lt", "le", "gt", "ge", "any")
#   - "minor_val": value to compare minor version against (not needed for "any")
CONJUR_POLICY_RULES = [
    {"major": 2, "minor_op": "ne", "minor_val": 6},  # 2.x except 2.6
    {"major": 3, "minor_op": "lt", "minor_val": 3},  # 3.x where minor < 3
]


def check_version_rule(major_ver, minor_ver, rule):
    """Check if a version matches a single policy rule."""
    if major_ver != rule["major"]:
        return False

    op = rule.get("minor_op", "any")
    val = rule.get("minor_val", 0)

    operators = {
        "eq": lambda m, v: m == v,
        "ne": lambda m, v: m != v,
        "lt": lambda m, v: m < v,
        "le": lambda m, v: m <= v,
        "gt": lambda m, v: m > v,
        "ge": lambda m, v: m >= v,
        "any": lambda m, v: True,
    }

    return operators.get(op, lambda m, v: False)(minor_ver, val)


def matches_conjur_policy(major_ver, minor_ver, rules=None):
    """Check if version matches any of the policy rules."""
    if rules is None:
        rules = CONJUR_POLICY_RULES

    return any(check_version_rule(major_ver, minor_ver, rule) for rule in rules)


def use_conjur_sidecar(framework, policy_rules=None):
    use_conjur = False

    if framework:
        name = get_val(framework, "name")
        version = get_val(framework, "version")

        if name == "stargate":
            versions = version.split(".")
            major_ver = int(versions[0]) if len(versions) > 0 else 0
            minor_ver = int(versions[1]) if len(versions) > 1 else 0
            if matches_conjur_policy(major_ver, minor_ver, policy_rules):
                use_conjur = True

    return use_conjur
