import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { FiEye, FiEyeOff } from "react-icons/fi";

/** Password/PIN field with an eye button to show what was typed. */
export const SecretInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function SecretInput(props, ref) {
    const [show, setShow] = useState(false);
    return (
      <div style={{ position: "relative" }}>
        <input
          {...props}
          ref={ref}
          type={show ? "text" : "password"}
          autoCapitalize="none"
          autoCorrect="off"
          className={`input ${props.className ?? ""}`.trim()}
          style={{ paddingRight: 52, ...props.style }}
        />
        <button
          type="button"
          aria-label={show ? "Hide" : "Show"}
          onClick={() => setShow((s) => !s)}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 42,
            height: 42,
            border: "none",
            background: "transparent",
            color: "inherit",
            opacity: 0.75,
            fontSize: 20,
            display: "grid",
            placeItems: "center"
          }}
        >
          {show ? <FiEyeOff /> : <FiEye />}
        </button>
      </div>
    );
  }
);

/** Common time zones; India first. Values are minutes east of UTC. */
export const TIME_ZONES: { label: string; minutes: number }[] = [
  { label: "India (IST, UTC+5:30)", minutes: 330 },
  { label: "Nepal (UTC+5:45)", minutes: 345 },
  { label: "Bangladesh (UTC+6:00)", minutes: 360 },
  { label: "Sri Lanka (UTC+5:30)", minutes: 330 },
  { label: "UAE / Dubai (UTC+4:00)", minutes: 240 },
  { label: "Singapore (UTC+8:00)", minutes: 480 },
  { label: "UK (UTC+0:00)", minutes: 0 },
  { label: "US Eastern (UTC-5:00)", minutes: -300 }
];
