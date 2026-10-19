/// <reference types="@rbxts/testez/globals" />

import { createMachine, StateMachine } from "..";
import { createTurnstile } from "./turnstile";

export = () => {
	describe("send", () => {
		it("follows transitions and reports whether one happened", () => {
			const turnstile = createTurnstile();

			expect(turnstile.send("push")).to.equal(false);
			expect(turnstile.send("coin", 25)).to.equal(true);
			expect(turnstile.getState()).to.equal("unlocked");
			expect(turnstile.is("unlocked")).to.equal(true);
			expect(turnstile.is("locked")).to.equal(false);
			expect(turnstile.context.coins).to.equal(1);
		});

		it("stays put when the guard rejects the payload", () => {
			const turnstile = createTurnstile();

			expect(turnstile.send("coin", 10)).to.equal(false);
			expect(turnstile.send("coin")).to.equal(false);
			expect(turnstile.getState()).to.equal("locked");
			expect(turnstile.context.coins).to.equal(0);
		});

		it("runs exit, action, enter and then listeners", () => {
			const log: string[] = [];
			const machine: StateMachine<"a" | "b", "go", object> = createMachine({
				initial: "a",
				context: {},
				states: {
					a: {
						exit: (_, to) => log.push(`exit a to ${to} while ${machine.getState()}`),
						on: {
							go: {
								target: "b",
								action: (_, payload) => log.push(`action ${payload} while ${machine.getState()}`),
							},
						},
					},
					b: {
						enter: (_, from, payload) =>
							log.push(`enter b from ${from} ${payload} while ${machine.getState()}`),
					},
				},
			});
			machine.onTransition((from, to, event) => log.push(`listener ${from} -> ${to} on ${event}`));

			machine.send("go", "hello");

			expect(log.join(" | ")).to.equal(
				"exit a to b while a | action hello while a | enter b from a hello while b | listener a -> b on go",
			);
		});

		it("queues events sent from hooks until the current transition is done", () => {
			const log: string[] = [];
			const machine: StateMachine<"a" | "b" | "c", "next", object> = createMachine({
				initial: "a",
				context: {},
				states: {
					a: { on: { next: "b" } },
					b: {
						enter: () => {
							log.push("enter b");
							log.push(`send returned ${machine.send("next")}`);
						},
						on: { next: "c" },
					},
					c: { enter: () => log.push("enter c") },
				},
			});
			machine.onTransition((from, to) => log.push(`${from} -> ${to}`));

			expect(machine.send("next")).to.equal(true);
			expect(machine.getState()).to.equal("c");
			expect(log.join(" | ")).to.equal("enter b | send returned false | a -> b | enter c | b -> c");
		});

		it("handles queued events in the order they were sent", () => {
			const machine: StateMachine<"a" | "b" | "c" | "d" | "wrongOrder", "go" | "first" | "second", object> =
				createMachine({
					initial: "a",
					context: {},
					states: {
						a: { on: { go: "b" } },
						b: {
							enter: () => {
								machine.send("first");
								machine.send("second");
							},
							// handling "second" first would end up in wrongOrder
							on: { first: "c", second: "wrongOrder" },
						},
						c: { on: { second: "d" } },
						d: {},
						wrongOrder: {},
					},
				});

			machine.send("go");

			expect(machine.getState()).to.equal("d");
		});

		it("treats a transition to the current state as a full exit and re-entry", () => {
			let enters = 0;
			let exits = 0;
			const machine = createMachine({
				initial: "stunned",
				context: {},
				states: {
					stunned: {
						enter: () => {
							enters += 1;
						},
						exit: () => {
							exits += 1;
						},
						on: { hit: "stunned" },
						after: { seconds: 2, target: "idle" },
					},
					idle: {},
				},
			});

			machine.update(1.5);
			expect(machine.send("hit")).to.equal(true);
			expect(enters).to.equal(2);
			expect(exits).to.equal(1);
			expect(machine.timeInState()).to.equal(0);

			machine.update(1.5);
			expect(machine.getState()).to.equal("stunned");
			machine.update(0.5);
			expect(machine.getState()).to.equal("idle");
		});

		it("lets guard errors through and stays usable", () => {
			const machine = createMachine({
				initial: "a",
				context: {},
				states: {
					a: {
						on: {
							bad: {
								target: "b",
								guard: () => {
									throw "guard exploded";
								},
							},
							good: "b",
						},
					},
					b: {},
				},
			});

			expect(() => machine.send("bad")).to.throw("guard exploded");
			expect(machine.getState()).to.equal("a");
			expect(machine.send("good")).to.equal(true);
		});

		it("drops events queued by a transition whose hook threw", () => {
			const machine: StateMachine<"a" | "b" | "c", "go" | "next", object> = createMachine({
				initial: "a",
				context: {},
				states: {
					a: { on: { go: "b" } },
					b: {
						enter: () => {
							machine.send("next");
							throw "enter failed";
						},
						on: { next: "c" },
					},
					c: {},
				},
			});

			expect(() => machine.send("go")).to.throw("enter failed");
			expect(machine.getState()).to.equal("b");

			// had "next" survived it would be handled after this send
			expect(machine.send("go")).to.equal(false);
			expect(machine.getState()).to.equal("b");
		});

		it("fails loudly when hooks keep sending each other events", () => {
			const machine: StateMachine<"start" | "ping" | "pong", "go" | "flip", object> = createMachine({
				initial: "start",
				context: {},
				states: {
					start: { on: { go: "ping" } },
					ping: { enter: () => machine.send("flip"), on: { flip: "pong" } },
					pong: { enter: () => machine.send("flip"), on: { flip: "ping" } },
				},
			});

			expect(() => machine.send("go")).to.throw("didn't settle after 100 queued events");
			expect(machine.can("flip")).to.equal(true);
		});
	});

	describe("can", () => {
		it("runs the guard without transitioning or calling any hook", () => {
			let guardCalls = 0;
			let hookCalls = 0;
			let listenerCalls = 0;

			const machine = createMachine({
				initial: "a",
				context: {},
				states: {
					a: {
						exit: () => {
							hookCalls += 1;
						},
						on: {
							go: {
								target: "b",
								guard: (_, allowed) => {
									guardCalls += 1;
									return allowed === true;
								},
							},
						},
					},
					b: {
						enter: () => {
							hookCalls += 1;
						},
					},
				},
			});
			machine.onTransition(() => {
				listenerCalls += 1;
			});

			expect(machine.can("go", true)).to.equal(true);
			expect(machine.can("go", false)).to.equal(false);
			expect(guardCalls).to.equal(2);
			expect(hookCalls).to.equal(0);
			expect(listenerCalls).to.equal(0);
			expect(machine.getState()).to.equal("a");
		});

		it("is false for events the current state ignores", () => {
			const turnstile = createTurnstile();

			expect(turnstile.can("push")).to.equal(false);
			turnstile.send("coin", 50);
			expect(turnstile.can("push")).to.equal(true);
			expect(turnstile.can("coin", 50)).to.equal(false);
		});
	});
};
