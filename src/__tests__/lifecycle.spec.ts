/// <reference types="@rbxts/testez/globals" />

import { createMachine, StateMachine } from "..";
import { createTurnstile } from "./turnstile";

export = () => {
	describe("onTransition", () => {
		it("reports the event, or undefined for timed transitions", () => {
			const machine = createMachine({
				initial: "ready",
				context: {},
				states: {
					ready: { on: { fire: "cooldown" } },
					cooldown: { after: { seconds: 0.5, target: "ready" } },
				},
			});
			const seen: string[] = [];
			machine.onTransition((from, to, event) => seen.push(`${from} -> ${to} on ${event}`));

			machine.send("fire");
			machine.update(0.5);

			expect(seen.join(" | ")).to.equal("ready -> cooldown on fire | cooldown -> ready on nil");
		});

		it("stops calling a listener as soon as it's disconnected, even mid notification", () => {
			const turnstile = createTurnstile();
			const calls: string[] = [];

			turnstile.onTransition(() => {
				calls.push("first");
				disconnectSecond();
			});
			const disconnectSecond = turnstile.onTransition(() => calls.push("second"));

			turnstile.send("coin", 25);
			turnstile.send("push");

			expect(calls.join(",")).to.equal("first,first");
		});

		it("keeps notifying the others when a listener disconnects itself", () => {
			const turnstile = createTurnstile();
			const calls: string[] = [];

			const disconnectFirst = turnstile.onTransition(() => {
				calls.push("first");
				disconnectFirst();
				disconnectFirst();
			});
			turnstile.onTransition(() => calls.push("second"));

			turnstile.send("coin", 25);
			turnstile.send("push");

			expect(calls.join(",")).to.equal("first,second,second");
		});

		it("doesn't leave the machine stuck when a listener throws", () => {
			const turnstile = createTurnstile();
			const disconnect = turnstile.onTransition(() => {
				throw "listener exploded";
			});

			expect(() => turnstile.send("coin", 25)).to.throw("listener exploded");
			expect(turnstile.getState()).to.equal("unlocked");

			disconnect();
			expect(turnstile.send("push")).to.equal(true);
		});
	});

	describe("destroy", () => {
		it("makes every other method throw and can be called again", () => {
			const turnstile = createTurnstile();
			turnstile.destroy();

			const calls = [
				() => turnstile.send("coin", 25),
				() => turnstile.can("coin", 25),
				() => turnstile.getState(),
				() => turnstile.is("locked"),
				() => turnstile.timeInState(),
				() => turnstile.update(0),
				() => turnstile.onTransition(() => {}),
			];
			for (const call of calls) {
				expect(call).to.throw("state machine was used after destroy()");
			}

			turnstile.destroy();
		});

		it("doesn't run the current state's exit hook", () => {
			let exited = false;
			const machine = createMachine({
				initial: "alive",
				context: {},
				states: {
					alive: {
						exit: () => {
							exited = true;
						},
					},
				},
			});

			machine.destroy();

			expect(exited).to.equal(false);
		});

		it("abandons the rest of a transition when a hook destroys the machine", () => {
			const log: string[] = [];
			const machine: StateMachine<"alive" | "dead", "die" | "respawn", object> = createMachine({
				initial: "alive",
				context: {},
				states: {
					alive: {
						on: {
							die: {
								target: "dead",
								action: () => {
									log.push("action");
									machine.send("respawn");
									machine.destroy();
								},
							},
						},
					},
					dead: {
						enter: () => log.push("enter dead"),
						on: { respawn: "alive" },
					},
				},
			});
			machine.onTransition(() => log.push("listener"));

			machine.send("die");

			expect(log.join(",")).to.equal("action");
		});

		it("stops the remaining listeners when one of them destroys the machine", () => {
			const turnstile = createTurnstile();
			const calls: string[] = [];

			turnstile.onTransition(() => {
				calls.push("first");
				turnstile.destroy();
			});
			turnstile.onTransition(() => calls.push("second"));

			turnstile.send("coin", 25);

			expect(calls.join(",")).to.equal("first");
		});
	});
};
