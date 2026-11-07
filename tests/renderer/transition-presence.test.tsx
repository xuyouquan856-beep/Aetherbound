// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransitionPresence } from "../../src/renderer/src/features/shell/TransitionPresence.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function animationDriver() {
  const animations: { finish(): void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const animate = vi.fn(() => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cancel = vi.fn();
    animations.push({ finish, cancel });
    return { finished, cancel } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate });
  return animations;
}

it("blocks departing content immediately and removes it after exit", async () => {
  const animations = animationDriver();
  const dialog = <div role="dialog">内容</div>;
  const view = render(<TransitionPresence>{dialog}</TransitionPresence>);
  await act(async () => animations[0].finish());
  view.rerender(<TransitionPresence>{false}</TransitionPresence>);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("内容").closest(".transition-presence")).toHaveAttribute("inert");
  await act(async () => animations.at(-1)!.finish());
  expect(screen.queryByText("内容")).not.toBeInTheDocument();
});

it("an old exit cannot remove a reopened surface", async () => {
  const animations = animationDriver();
  const dialog = <div role="dialog">内容</div>;
  const view = render(<TransitionPresence>{dialog}</TransitionPresence>);
  view.rerender(<TransitionPresence>{false}</TransitionPresence>);
  const exit = animations.at(-1)!;
  view.rerender(<TransitionPresence>{dialog}</TransitionPresence>);
  expect(exit.cancel).toHaveBeenCalled();
  await act(async () => exit.finish());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("dialog").closest(".transition-presence")).not.toHaveAttribute("inert");
});

it("reduced motion removes the surface immediately", () => {
  const animations = animationDriver();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const view = render(<TransitionPresence><div role="dialog">内容</div></TransitionPresence>);
  view.rerender(<TransitionPresence>{false}</TransitionPresence>);
  expect(screen.queryByText("内容")).not.toBeInTheDocument();
  expect(animations).toHaveLength(0);
});
