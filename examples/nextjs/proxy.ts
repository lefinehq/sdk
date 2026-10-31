// Sends each visitor to their language (/en, /de, ...). Written by `npx lefine init`.
import { lefine } from "./lefine";

export default lefine.proxy;
export const config = { matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"] };
