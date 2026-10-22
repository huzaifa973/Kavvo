import { randomInt } from "node:crypto";
import { SkillInputError, type Skill } from "../types.js";

export interface PasswordGenerateInput {
  /** Password length, 8 to 128. Defaults to 16. */
  length?: number;
  /** Include symbol characters in the alphabet. Defaults to false. */
  symbols?: boolean;
}

export interface PasswordGenerateResult {
  password: string;
}

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}<>?";

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const DEFAULT_LENGTH = 16;

export const passwordGenerateSkill: Skill<
  PasswordGenerateInput,
  PasswordGenerateResult
> = {
  id: "util.password-generate",
  name: "Generate Password",
  description:
    "Generates a random password with cryptographically secure randomness (letters and digits, symbols optional).",
  inputSchema: {
    type: "object",
    properties: {
      length: {
        type: "number",
        minimum: MIN_LENGTH,
        maximum: MAX_LENGTH,
      },
      symbols: { type: "boolean" },
    },
    required: [],
  },
  run(input) {
    const length = input?.length === undefined ? DEFAULT_LENGTH : input.length;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < MIN_LENGTH ||
      length > MAX_LENGTH
    ) {
      throw new SkillInputError(
        "util.password-generate",
        `"length" must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}`,
      );
    }
    const alphabet =
      LOWERCASE + UPPERCASE + DIGITS + (input?.symbols ? SYMBOLS : "");
    let password = "";
    for (let i = 0; i < length; i += 1) {
      // randomInt is unbiased, unlike modulo over a random byte.
      password += alphabet[randomInt(alphabet.length)];
    }
    return { password };
  },
};
