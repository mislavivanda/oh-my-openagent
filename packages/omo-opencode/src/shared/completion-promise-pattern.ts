function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function containsCompletionPromise(text: string, promise: string): boolean {
	const escapedPromise = escapeRegex(promise)
	return new RegExp(`<promise>\\s*${escapedPromise}\\s*</promise>`, "is").test(text)
}
