import { configure } from "@testing-library/dom"

// The markdown preview loads its editor lazily; on a slow runner the default one second
// is not enough for findBy*/waitFor, and the release gate failed on it once.
configure({ asyncUtilTimeout: 5000 })
