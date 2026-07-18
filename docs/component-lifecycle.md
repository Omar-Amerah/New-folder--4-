# Component lifecycle and thermal ordering

This document describes the current authoritative lifecycle. Earlier ship-global Power notes are superseded by this behavior.

Power is routed through normalized Wiring v2. Each live Power network has its own sources, consumers, available generation, demand, load ratio, and component Power multiplier. Generator thermal state only gates that source at OVERHEATED; NORMAL through CRITICAL provide nominal output, and OVERHEATED provides zero; an allocation refresh reuses cached topology and does not rebuild Data networks or increment `wiringRevision`. A topology rebuild is reserved for endpoint, hosted-route, or blueprint changes.

HP mutations use one deferred lifecycle batch. At flush, the server (1) completes mutations, (2) observes alive boundaries, (3) refreshes damage-scaled Heat Sink capacity and adjacent bonuses, (4) rebuilds dynamic hull exposure when required, (5) rebuilds live Frame/Heat Pipe routes when required, (6) rebuilds runtime Wiring topology when required, (7) allocates network-local Power, (8) refreshes Power-dependent effective stats, and (9) dirties compact component/Heat/Power snapshot state. Ordinary non-boundary damage does not rebuild topology.

Heat Sinks are passive (`powerUse: 0`). Radiators have Power-scaled active cooling plus a passive recovery floor. Destroyed components retain stored heat and conduct as wrecks, but cannot act as live thermal-route nodes. Destroyed hull occupancy changes exposure. Destroying a generator immediately resets its meltdown progress; whole-ship teardown clears every meltdown timer while preserving stored component heat and setting live aggregate capacity to zero.

Blueprint Heat analysis consumes the design and its normalized Wiring v2 state. Active consumer output and heat use the component's network-local Power multiplier once, disconnected radiators retain only passive cooling, and generator load heat is based on local connected demand. Runtime remains authoritative.
