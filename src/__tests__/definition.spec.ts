/// <reference types="@rbxts/testez/globals" />

import { createMachine } from "..";

export = () => {
	describe("createMachine", () => {
		it("starts in the initial state and enters it with no source state", () => {
			let entered = 0;
			let enteredFrom: string | undefined = "not called";

			const machine = createMachine({
				initial: "idle",
				context: {},
				states: {
					idle: {
						enter: (_, from) => {
							entered += 1;
							enteredFrom = from;
						},
					},
				},
			});

			expect(machine.getState()).to.equal("idle");
			expect(entered).to.equal(1);
			expect(enteredFrom).never.to.be.ok();
		});

		it("keeps the context object it was given", () => {
			const context = { health: 100 };
			const machine = createMachine({ initial: "idle", context, states: { idle: {} } });

			expect(machine.context).to.equal(context);
		});

		it("rejects an initial state that isn't defined", () => {
			expect(() => {
				createMachine({ initial: "nowhere", context: {}, states: { idle: {} } } as never);
			}).to.throw(`initial state "nowhere" isn't defined`);
		});

		it("rejects transitions to states that aren't defined", () => {
			expect(() => {
				createMachine({
					initial: "idle",
					context: {},
					states: { idle: { on: { go: "nowhere" } } },
				} as never);
			}).to.throw(`state "idle" sends "go" to "nowhere", which isn't defined`);

			expect(() => {
				createMachine({
					initial: "idle",
					context: {},
					states: { idle: { on: { go: { action: () => {} } } } },
				} as never);
			}).to.throw('state "idle" sends "go" to nil');
		});

		it("rejects timers that could never fire properly", () => {
			for (const seconds of [0, -1, 0 / 0, math.huge]) {
				expect(() => {
					createMachine({
						initial: "idle",
						context: {},
						states: { idle: { after: { seconds, target: "idle" } } },
					});
				}).to.throw("expected a positive number");
			}

			expect(() => {
				createMachine({
					initial: "idle",
					context: {},
					states: { idle: { after: { seconds: 1, target: "nowhere" } } },
				} as never);
			}).to.throw('state "idle" times out to "nowhere"');
		});

		it("isn't affected by later changes to the definition", () => {
			const toB = { target: "b" as "a" | "b" | "c" };
			const definition = {
				initial: "a" as const,
				context: {},
				states: {
					a: { on: { go: toB, skip: "b" as "a" | "b" | "c" } },
					b: { on: { back: "a" as const } },
					c: {},
				},
			};
			const machine = createMachine(definition);

			toB.target = "c";
			definition.states.a.on.skip = "c";

			expect(machine.send("go")).to.equal(true);
			expect(machine.getState()).to.equal("b");
			machine.send("back");
			machine.send("skip");
			expect(machine.getState()).to.equal("b");
		});
	});
};
