import { createMachine } from "..";

export function createTurnstile() {
	return createMachine({
		initial: "locked",
		context: { coins: 0 },
		states: {
			locked: {
				on: {
					coin: {
						target: "unlocked",
						guard: (_, amount) => typeIs(amount, "number") && amount >= 25,
						action: (context) => {
							context.coins += 1;
						},
					},
				},
			},
			unlocked: { on: { push: "locked" } },
		},
	});
}
