# Included in the generated connector. Link and the JSON helpers are supplied by
# the platform connector. Both routes install against the same config lock.

def managed_install(private, targets, catalog, name):
    if name not in (MANAGED_POLICY["web"], MANAGED_POLICY["ssh"]):
        raise ValueError("Unexpected CMCP transport name")
    directory = private.parent / MANAGED_POLICY["name"]
    if directory.is_symlink():
        raise ValueError("Unsafe CMCP connector directory")
    return install_connector(directory, targets, catalog, MANAGED_POLICY["name"], MANAGED_POLICY)


def remove_managed_aliases(servers, private, entry, policy):
    for alias in (policy["web"], policy["ssh"]):
        existing = servers.get(alias)
        args = existing.get("args", []) if isinstance(existing, dict) else []
        expected = str(private.parent / alias / "connector.py")
        if isinstance(args, list) and args[:5] == ["-u", expected, "serve", "--name", alias]:
            del servers[alias]
    existing = servers.get(policy["name"])
    if existing is not None and existing != entry:
        args = existing.get("args", []) if isinstance(existing, dict) else []
        if not isinstance(args, list) or args[:5] != entry["args"][:5]:
            raise ValueError("Managed CMCP name is already in use")


class ManagedLink(Link):
    def __init__(self, private):
        super().__init__()
        self.private = private

    def links(self):
        try:
            policy = read_json(self.private / "connection-policy.json")
        except (OSError, ValueError):
            return []
        if not isinstance(policy, dict) or any(policy.get(k) != MANAGED_POLICY[k] for k in ("key", "name", "ssh", "web")):
            return []
        primary = policy.get("primary")
        if primary not in ("ssh", "url"):
            return []
        order = [primary]
        if policy.get("dual") is True:
            order.append("url" if primary == "ssh" else "ssh")
        links = []
        for route in order:
            name = policy["ssh" if route == "ssh" else "web"]
            link = Link(self.private.parent / name / "relay" / "link.sock")
            link.on_ask = self.on_ask
            links.append(link)
        return links

    def available(self, link):
        state = link.status()
        return state.get("connected") is True and (state.get("pc") or {}).get("machine") == MANAGED_POLICY["key"]

    def request(self, message, wait=30):
        deadline = time.monotonic() + max(0, min(wait, self.recovery_wait))
        while True:
            for link in self.links():
                if not self.available(link):
                    continue
                try:
                    # Only Offline proves this call was never delivered. The
                    # base Link keeps result recovery on the original route.
                    link.fallback_on_not_sent = True
                    return link.request(message, wait)
                except Offline:
                    continue
            if time.monotonic() >= deadline:
                raise Offline(OFFLINE_TEXT)
            time.sleep(min(self.poll, max(0, deadline - time.monotonic())))

    def watch_socket(self):
        for link in self.links():
            if self.available(link):
                return link.path
        raise FileNotFoundError("CMCP routes are offline")
