import { createMachine, Transition } from "..";

// compile time checks, this module is never required. roblox-ts doesn't allow @ts-expect-error, so
// these assert exact types instead: an Expect<false> anywhere below fails the build

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export function createTurret() {
	return createMachine({
		initial: "idle",
		context: { ammo: 30 },
		states: {
			idle: { on: { spotted: "tracking" } },
			tracking: {
				on: {
					lost: "idle",
					aligned: { target: "firing", guard: (context) => context.ammo > 0 },
				},
			},
			firing: {
				enter: (context) => {
					context.ammo -= 1;
				},
				after: { seconds: 0.2, target: "tracking" },
			},
		},
	});
}

type Turret = ReturnType<typeof createTurret>;
type States = "idle" | "tracking" | "firing";

export type Checks = [
	// names come out exact, so a misspelled send("spoted") or is("reloading") doesn't compile
	Expect<Equals<Parameters<Turret["send"]>[0], "spotted" | "lost" | "aligned">>,
	Expect<Equals<ReturnType<Turret["getState"]>, States>>,
	Expect<Equals<Parameters<Turret["is"]>[0], States>>,
	Expect<Equals<Turret["context"], { ammo: number }>>,
	// a target or timer naming a state that isn't defined is rejected rather than inferred as a new one
	Expect<Equals<"chsae" extends Transition<States, object> ? true : false, false>>,
	Expect<Equals<"firing" extends Transition<States, object> ? true : false, true>>,
];
