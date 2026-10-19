/// <reference types="@rbxts/testez/globals" />

import { createMachine, StateMachine } from "..";
import { createTurnstile } from "./turnstile";

export = () => {
	describe("update", () => {
		it("counts time in the current state and calls its update hook", () => {
			const steps: number[] = [];
			const machine = createMachine({
				initial: "a",
				context: {},
				states: { a: { update: (_, dt) => steps.push(dt) } },
			});

			machine.update(0.25);
			machine.update(0.5);

			expect(steps.join(",")).to.equal("0.25,0.5");
			expect(machine.timeInState()).to.equal(0.75);
		});

		it("hands the update hook the machine's context", () => {
			const machine = createMachine({
				initial: "regenerating",
				context: { health: 50 },
				states: {
					regenerating: {
						update: (context, dt) => {
							context.health = math.min(context.health + 10 * dt, 100);
						},
					},
				},
			});

			machine.update(2);

			expect(machine.context.health).to.equal(70);
		});

		it("takes the after transition once the state has lasted long enough", () => {
			const machine = createMachine({
				initial: "windup",
				context: {},
				states: {
					windup: { after: { seconds: 1, target: "strike" } },
					strike: {},
				},
			});

			machine.update(0.5);
			expect(machine.getState()).to.equal("windup");
			machine.update(0.5);
			expect(machine.getState()).to.equal("strike");
		});

		it("takes at most one timed transition per update, however large the step", () => {
			const machine = createMachine({
				initial: "a",
				context: {},
				states: {
					a: { after: { seconds: 1, target: "b" } },
					b: { after: { seconds: 1, target: "c" } },
					c: {},
				},
			});

			machine.update(10);
			expect(machine.getState()).to.equal("b");
			expect(machine.timeInState()).to.equal(0);

			machine.update(1);
			expect(machine.getState()).to.equal("c");
		});

		it("lets events from the update hook win over a timer running out in the same step", () => {
			const machine: StateMachine<"searching" | "engaging" | "givingUp", "found", object> = createMachine({
				initial: "searching",
				context: {},
				states: {
					searching: {
						update: () => {
							if (machine.timeInState() >= 1) {
								machine.send("found");
							}
						},
						on: { found: "engaging" },
						after: { seconds: 1, target: "givingUp" },
					},
					engaging: { after: { seconds: 5, target: "givingUp" } },
					givingUp: {},
				},
			});

			machine.update(1);

			expect(machine.getState()).to.equal("engaging");
			expect(machine.timeInState()).to.equal(0);
		});

		it("starts every state's timer from zero", () => {
			const machine = createMachine({
				initial: "ready",
				context: {},
				states: {
					ready: { on: { fire: "cooldown" } },
					cooldown: { after: { seconds: 0.5, target: "ready" } },
				},
			});

			machine.update(3);
			machine.send("fire");
			machine.update(0.4);
			expect(machine.getState()).to.equal("cooldown");
			machine.update(0.1);
			expect(machine.getState()).to.equal("ready");
		});

		it("rejects negative, NaN and infinite steps", () => {
			const turnstile = createTurnstile();

			for (const dt of [-1, 0 / 0, math.huge]) {
				expect(() => turnstile.update(dt)).to.throw("expects a finite dt >= 0");
			}
			turnstile.update(0);
		});

		it("can't be called from inside one of the machine's callbacks", () => {
			const turnstile = createTurnstile();
			const disconnect = turnstile.onTransition(() => turnstile.update(0));

			expect(() => turnstile.send("coin", 25)).to.throw("can't be called from inside one of its own callbacks");
			expect(turnstile.getState()).to.equal("unlocked");

			disconnect();
			expect(turnstile.send("push")).to.equal(true);
		});
	});
};
