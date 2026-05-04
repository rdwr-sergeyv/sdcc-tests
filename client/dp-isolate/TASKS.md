# DP Isolate Test Client Tasks

## Next

- Check whether the lab and its devices are accessible from home.
- If lab device access works, run a container with a backend instance that can perform the actual device configuration updates.

## Notes

- Current Docker setup runs the legacy portal and MongoDB, but not a backend worker/service.
- The current `no-attack-zone-dps` fixture has active incidents, but no DefensePros in `attack_zone`, so enable isolation is expected to be blocked or fail before a successful device update path can be tested.
