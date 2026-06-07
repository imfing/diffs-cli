import { BrowserRouter, Routes, Route } from "react-router";
import { Home } from "./components/Home";
import { DiffView } from "./components/DiffView";
import { GuideView } from "./components/guide/GuideView";
import { NotFound } from "./components/NotFound";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/local" element={<DiffView source="local" />} />
        <Route path="/branch" element={<DiffView source="branch" />} />
        <Route path="/:org/:repo/pull/:number" element={<DiffView />} />
        <Route path="/guide/:slug" element={<GuideView />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
