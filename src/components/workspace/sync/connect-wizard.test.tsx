// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { SyncPortError } from "@/lib/sync/sync-port"
import { ConnectWizard } from "./connect-wizard"
import {
  CONNECTED,
  FAKE_CODE,
  FAKE_CODE_GROUPS,
  createFakePort,
  type FakePort,
} from "./fake-sync-port"

const SERVER = "https://sync.example.com"
const STRONG = "correct horse battery staple 42"

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }))
}

function button(name: string | RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement
}

function renderWizard(port: FakePort, props: { onConnected?: () => void } = {}) {
  const onConnected = props.onConnected ?? vi.fn()
  const view = render(
    <ConnectWizard port={port} onConnected={onConnected} defaultDeviceName="Mac mini" />,
  )
  return { ...view, onConnected }
}

/** Server step done: the address checked and found. */
async function chooseServer(port: FakePort) {
  void port
  type("Адрес сервера", SERVER)
  click("Проверить сервер")
  await screen.findByText(/Сервер найден/)
}

async function fillCreateForm(password = STRONG, repeat = password) {
  type("Имя пользователя", "alice")
  type("Код приглашения", "AAAA-BBBB-CCCC-DDDD-EEEE")
  type("Пароль", password)
  type("Повторите пароль", repeat)
  await screen.findByTestId("password-strength")
}

async function reachRecoveryStep(port: FakePort) {
  await chooseServer(port)
  click("Создать учётную запись")
  await fillCreateForm()
  await waitFor(() => expect(button("Продолжить").disabled).toBe(false))
  click("Продолжить")
  await screen.findByTestId("recovery-code")
}

describe("the connect wizard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe("the server step", () => {
    it("cannot check an empty address", () => {
      renderWizard(createFakePort())
      expect(button("Проверить сервер").disabled).toBe(true)
      type("Адрес сервера", "  ")
      expect(button("Проверить сервер").disabled).toBe(true)
      type("Адрес сервера", SERVER)
      expect(button("Проверить сервер").disabled).toBe(false)
    })

    it("asks the port to check the address and offers the three ways on", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      expect(port.checkServer).toHaveBeenCalledWith({ url: SERVER, allowHttp: false })
      expect(screen.getByText(/0\.1\.0/)).toBeTruthy()
      expect(screen.getByRole("button", { name: "Создать учётную запись" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Войти" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Забыли пароль?" })).toBeTruthy()
    })

    it.each([
      ["insecure_url", /https:\/\//],
      ["network", /Не удалось связаться с сервером/],
      ["timeout", /не ответил/],
      ["bad_response", /не похож на ответ сервера/],
      ["unsupported_server", /другой версии/],
    ])("tells what is wrong when the check fails with %s", async (code, message) => {
      const port = createFakePort({
        checkServer: async () => {
          throw new SyncPortError(code)
        },
      })
      renderWizard(port)
      type("Адрес сервера", SERVER)
      click("Проверить сервер")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(message)
      expect(screen.queryByRole("button", { name: "Создать учётную запись" })).toBeNull()
    })

    it("warns about plain http and passes the choice on", async () => {
      // П41, Р11: «в локальной сети» is an explicit switch with a warning
      const port = createFakePort()
      renderWizard(port)
      expect(screen.queryByText(/идут по сети открыто/)).toBeNull()
      fireEvent.click(screen.getByRole("switch", { name: /локальной сети/ }))
      expect(screen.getByText(/идут по сети открыто/)).toBeTruthy()
      type("Адрес сервера", "http://192.168.1.20:8080")
      click("Проверить сервер")
      await screen.findByText(/Сервер найден/)
      expect(port.checkServer).toHaveBeenCalledWith({
        url: "http://192.168.1.20:8080",
        allowHttp: true,
      })
    })

    it("starts from the server of a record whose keys were lost", () => {
      render(
        <ConnectWizard
          port={createFakePort()}
          onConnected={vi.fn()}
          initial={{ url: SERVER, allowHttp: false, username: "alice" }}
        />,
      )
      expect((screen.getByLabelText("Адрес сервера") as HTMLInputElement).value).toBe(SERVER)
    })
  })

  describe("creating an account", () => {
    it("asks for the name, the invitation code, the password twice and the device name", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      expect(screen.getByLabelText("Имя пользователя")).toBeTruthy()
      expect(screen.getByLabelText("Код приглашения")).toBeTruthy()
      expect((screen.getByLabelText("Пароль") as HTMLInputElement).type).toBe("password")
      expect((screen.getByLabelText("Повторите пароль") as HTMLInputElement).type).toBe("password")
      expect((screen.getByLabelText("Название устройства") as HTMLInputElement).value).toBe(
        "Mac mini",
      )
    })

    it("does not go on with a weak password and says so", async () => {
      // Р5: a weak password is not accepted
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm("password12345678")
      await waitFor(() =>
        expect(screen.getByTestId("password-strength").textContent).toMatch(/Слабый пароль/),
      )
      expect(button("Продолжить").disabled).toBe(true)
      click("Продолжить")
      expect(port.prepareAccount).not.toHaveBeenCalled()
    })

    it("says that the password is too short before it says anything about strength", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm("Short1!")
      await waitFor(() =>
        expect(screen.getByTestId("password-strength").textContent).toMatch(
          /Не короче 12 символов/,
        ),
      )
      expect(button("Продолжить").disabled).toBe(true)
    })

    it("does not go on when the two passwords differ", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm(STRONG, STRONG + "x")
      expect(screen.getByText("Пароли не совпадают")).toBeTruthy()
      expect(button("Продолжить").disabled).toBe(true)
    })

    it("does not go on with an empty name or invitation code", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm()
      await waitFor(() => expect(button("Продолжить").disabled).toBe(false))
      type("Код приглашения", "")
      expect(button("Продолжить").disabled).toBe(true)
    })

    it("shows the strength of a good password", async () => {
      const port = createFakePort()
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm()
      await waitFor(() =>
        expect(screen.getByTestId("password-strength").textContent).toMatch(/Отличный|Хороший/),
      )
      expect(port.checkPassword).toHaveBeenCalledWith(STRONG, "alice")
    })

    it("prepares the account on the device and goes to the recovery code", async () => {
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      expect(port.prepareAccount).toHaveBeenCalledWith({
        url: SERVER,
        allowHttp: false,
        username: "alice",
        enrollCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
        password: STRONG,
        deviceName: "Mac mini",
      })
      expect(port.confirmRecoveryCode).not.toHaveBeenCalled()
    })

    it.each([
      ["invalid_username", /Имя пользователя: /],
      ["weak_password", /слишком простой/],
      ["keychain_unavailable", /связк/],
    ])("shows the answer %s of the application and stays on the form", async (code, message) => {
      const port = createFakePort({
        prepareAccount: async () => {
          throw new SyncPortError(code)
        },
      })
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm()
      await waitFor(() => expect(button("Продолжить").disabled).toBe(false))
      click("Продолжить")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(message)
      expect(screen.getByLabelText("Имя пользователя")).toBeTruthy()
    })

    it("sends one request however often the button is pressed", async () => {
      let release: (() => void) | undefined
      const port = createFakePort({
        prepareAccount: () =>
          new Promise((resolve) => {
            release = () => resolve({ recoveryCode: FAKE_CODE, confirmGroups: [3, 9] })
          }),
      })
      renderWizard(port)
      await chooseServer(port)
      click("Создать учётную запись")
      await fillCreateForm()
      await waitFor(() => expect(button("Продолжить").disabled).toBe(false))
      click("Продолжить")
      fireEvent.click(screen.getByRole("button", { name: /Продолжить|Подождите/ }))
      expect(port.prepareAccount).toHaveBeenCalledTimes(1)
      release?.()
      await screen.findByTestId("recovery-code")
    })
  })

  describe("the recovery code step", () => {
    it("shows the code, says what happens without it, and offers to keep it", async () => {
      // О3: the honest text
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      expect(screen.getByTestId("recovery-code").textContent).toBe(FAKE_CODE)
      const page = document.body.textContent ?? ""
      expect(page).toMatch(/потеряете и пароль, и этот код/)
      expect(page).toMatch(/не вернёт никто/)
      expect(screen.getByRole("button", { name: "Сохранить в файл" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Напечатать" })).toBeTruthy()
    })

    it("asks to type back the groups the application chose", async () => {
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      expect(screen.getByLabelText("Группа 3")).toBeTruthy()
      expect(screen.getByLabelText("Группа 9")).toBeTruthy()
      expect(screen.queryByLabelText("Группа 1")).toBeNull()
    })

    it("cannot be left forward without typing the groups", async () => {
      // О3: not a single way on until the person has typed part of the code
      const port = createFakePort()
      const { onConnected } = renderWizard(port)
      await reachRecoveryStep(port)
      expect(button("Подтвердить и подключиться").disabled).toBe(true)
      type("Группа 3", "3333")
      expect(button("Подтвердить и подключиться").disabled).toBe(true)
      expect(
        screen.queryByRole("button", { name: /Готово|Далее|Продолжить|Пропустить/ }),
      ).toBeNull()
      expect(port.confirmRecoveryCode).not.toHaveBeenCalled()
      expect(onConnected).not.toHaveBeenCalled()
    })

    it("keeps the person on the step after wrong groups and says so", async () => {
      const port = createFakePort()
      const { onConnected } = renderWizard(port)
      await reachRecoveryStep(port)
      type("Группа 3", "0000")
      type("Группа 9", "1111")
      click("Подтвердить и подключиться")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(/не совпадают с кодом/)
      expect(port.confirmRecoveryCode).toHaveBeenCalledWith(["0000", "1111"])
      expect(screen.getByTestId("recovery-code")).toBeTruthy()
      expect(onConnected).not.toHaveBeenCalled()
    })

    it("connects when the groups are right, however they are typed", async () => {
      const port = createFakePort()
      const { onConnected } = renderWizard(port)
      await reachRecoveryStep(port)
      type("Группа 3", " 3333 ")
      type("Группа 9", "9999")
      click("Подтвердить и подключиться")
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CONNECTED))
      expect(port.confirmRecoveryCode).toHaveBeenCalledWith(["3333", "9999"])
    })

    it("does not keep the code on the screen once the device is connected", async () => {
      const port = createFakePort()
      const { container } = renderWizard(port)
      await reachRecoveryStep(port)
      type("Группа 3", "3333")
      type("Группа 9", "9999")
      click("Подтвердить и подключиться")
      await waitFor(() => expect(screen.queryByTestId("recovery-code")).toBeNull())
      for (const group of FAKE_CODE_GROUPS) expect(container.textContent ?? "").not.toContain(group)
    })

    it("shows an error of the server after the confirmation and lets the person go back", async () => {
      // П17: a wrong invitation code is only known to the server at this moment
      const port = createFakePort({
        confirmRecoveryCode: async () => {
          throw new SyncPortError("invalid_enroll_code")
        },
      })
      renderWizard(port)
      await reachRecoveryStep(port)
      type("Группа 3", "3333")
      type("Группа 9", "9999")
      click("Подтвердить и подключиться")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(/Код приглашения неверен/)
      click("Назад")
      expect(port.cancelPending).toHaveBeenCalled()
      expect(screen.getByLabelText("Код приглашения")).toBeTruthy()
    })

    it("saves the code to a file and tells where", async () => {
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      click("Сохранить в файл")
      await screen.findByText(/amby-recovery-code\.txt/)
      const contents = port.saveRecoveryCode.mock.calls[0][0]
      expect(contents).toContain(FAKE_CODE)
      expect(contents).toContain("sync.example.com")
      expect(contents).not.toContain(STRONG)
    })

    it("says nothing when the person cancelled the save dialog", async () => {
      const port = createFakePort({ saveRecoveryCode: async () => null })
      renderWizard(port)
      await reachRecoveryStep(port)
      click("Сохранить в файл")
      await waitFor(() => expect(port.saveRecoveryCode).toHaveBeenCalled())
      expect(screen.queryByText(/Сохранено/)).toBeNull()
      expect(screen.queryByRole("alert")).toBeNull()
    })

    it("shows the error when the file cannot be written", async () => {
      const port = createFakePort({
        saveRecoveryCode: async () => {
          throw new SyncPortError("storage_error")
        },
      })
      renderWizard(port)
      await reachRecoveryStep(port)
      click("Сохранить в файл")
      expect((await screen.findByRole("alert")).textContent).toMatch(/Не удалось сохранить/)
    })

    it("prints the code", async () => {
      // happy-dom has no `print`: a stand-in is put there
      const print = vi.fn()
      window.print = print as unknown as typeof window.print
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      click("Напечатать")
      expect(print).toHaveBeenCalledTimes(1)
    })

    it("forgets the prepared account when the person goes back", async () => {
      const port = createFakePort()
      renderWizard(port)
      await reachRecoveryStep(port)
      click("Назад")
      expect(port.cancelPending).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId("recovery-code")).toBeNull()
      // the password is not kept in the fields
      expect((screen.getByLabelText("Пароль") as HTMLInputElement).value).toBe("")
      expect((screen.getByLabelText("Имя пользователя") as HTMLInputElement).value).toBe("alice")
    })

    it("forgets the prepared account when the wizard is closed", async () => {
      const port = createFakePort()
      const { unmount } = renderWizard(port)
      await reachRecoveryStep(port)
      unmount()
      expect(port.cancelPending).toHaveBeenCalled()
    })
  })

  describe("signing in", () => {
    async function openSignIn(port: FakePort) {
      await chooseServer(port)
      click("Войти")
    }

    it("asks for the name, the password and the device name", async () => {
      const port = createFakePort()
      renderWizard(port)
      await openSignIn(port)
      type("Имя пользователя", "alice")
      type("Пароль", STRONG)
      expect((screen.getByLabelText("Пароль") as HTMLInputElement).type).toBe("password")
      click("Войти")
      await waitFor(() =>
        expect(port.signIn).toHaveBeenCalledWith({
          url: SERVER,
          allowHttp: false,
          username: "alice",
          password: STRONG,
          deviceName: "Mac mini",
        }),
      )
    })

    it("cannot be sent without a name and a password", async () => {
      const port = createFakePort()
      renderWizard(port)
      await openSignIn(port)
      expect(button("Войти").disabled).toBe(true)
      type("Имя пользователя", "alice")
      expect(button("Войти").disabled).toBe(true)
      type("Пароль", "x")
      expect(button("Войти").disabled).toBe(false)
    })

    it("reports the connection", async () => {
      const port = createFakePort()
      const { onConnected } = renderWizard(port)
      await openSignIn(port)
      type("Имя пользователя", "alice")
      type("Пароль", STRONG)
      click("Войти")
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CONNECTED))
    })

    it("does not judge the strength of a password that already exists", async () => {
      // a person with an old, short password must still be able to sign in
      const port = createFakePort()
      renderWizard(port)
      await openSignIn(port)
      type("Пароль", "short")
      expect(screen.queryByTestId("password-strength")).toBeNull()
      expect(port.checkPassword).not.toHaveBeenCalled()
    })

    it("explains a wrong password in plain words and keeps the form", async () => {
      const port = createFakePort({
        signIn: async () => {
          throw new SyncPortError("invalid_credentials")
        },
      })
      renderWizard(port)
      await openSignIn(port)
      type("Имя пользователя", "alice")
      type("Пароль", "wrong")
      click("Войти")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toBe("Неверное имя пользователя, пароль или код восстановления.")
      expect((screen.getByLabelText("Имя пользователя") as HTMLInputElement).value).toBe("alice")
    })

    it("says how long to wait after too many tries", async () => {
      const port = createFakePort({
        signIn: async () => {
          throw new SyncPortError("rate_limited", 840)
        },
      })
      renderWizard(port)
      await openSignIn(port)
      type("Имя пользователя", "alice")
      type("Пароль", "wrong")
      click("Войти")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(/Слишком много неудачных попыток/)
      expect(alert.textContent).toContain("14 мин")
    })

    it("shows the error of the server when the network is down", async () => {
      const port = createFakePort({
        signIn: async () => {
          throw new SyncPortError("network")
        },
      })
      renderWizard(port)
      await openSignIn(port)
      type("Имя пользователя", "alice")
      type("Пароль", STRONG)
      click("Войти")
      expect((await screen.findByRole("alert")).textContent).toMatch(/Не удалось связаться/)
    })

    it("goes back to the server step", async () => {
      const port = createFakePort()
      renderWizard(port)
      await openSignIn(port)
      click("Назад")
      expect(screen.getByRole("button", { name: "Создать учётную запись" })).toBeTruthy()
    })
  })

  describe("recovering a forgotten password", () => {
    async function openRecover(port: FakePort) {
      await chooseServer(port)
      click("Забыли пароль?")
    }

    it("asks for the name, the recovery code and a new password twice", async () => {
      const port = createFakePort()
      renderWizard(port)
      await openRecover(port)
      expect(screen.getByLabelText("Имя пользователя")).toBeTruthy()
      expect(screen.getByLabelText("Код восстановления")).toBeTruthy()
      expect((screen.getByLabelText("Новый пароль") as HTMLInputElement).type).toBe("password")
      expect(screen.getByLabelText("Повторите новый пароль")).toBeTruthy()
    })

    it("does not accept a weak new password", async () => {
      const port = createFakePort()
      renderWizard(port)
      await openRecover(port)
      type("Имя пользователя", "alice")
      type("Код восстановления", FAKE_CODE)
      type("Новый пароль", "password12345678")
      type("Повторите новый пароль", "password12345678")
      await waitFor(() =>
        expect(screen.getByTestId("password-strength").textContent).toMatch(/Слабый/),
      )
      expect(button("Восстановить доступ").disabled).toBe(true)
    })

    it("recovers with a strong new password and reports the connection", async () => {
      const port = createFakePort()
      const { onConnected } = renderWizard(port)
      await openRecover(port)
      type("Имя пользователя", "alice")
      type("Код восстановления", FAKE_CODE.toLowerCase())
      type("Новый пароль", STRONG)
      type("Повторите новый пароль", STRONG)
      await waitFor(() => expect(button("Восстановить доступ").disabled).toBe(false))
      click("Восстановить доступ")
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CONNECTED))
      expect(port.recover).toHaveBeenCalledWith({
        url: SERVER,
        allowHttp: false,
        username: "alice",
        recoveryCode: FAKE_CODE.toLowerCase(),
        newPassword: STRONG,
        deviceName: "Mac mini",
      })
    })

    it.each([
      ["invalid_recovery_code", /записан неверно/],
      ["invalid_credentials", /Неверное имя/],
    ])("explains %s", async (code, message) => {
      const port = createFakePort({
        recover: async () => {
          throw new SyncPortError(code)
        },
      })
      renderWizard(port)
      await openRecover(port)
      type("Имя пользователя", "alice")
      type("Код восстановления", "wrong")
      type("Новый пароль", STRONG)
      type("Повторите новый пароль", STRONG)
      await waitFor(() => expect(button("Восстановить доступ").disabled).toBe(false))
      click("Восстановить доступ")
      expect((await screen.findByRole("alert")).textContent).toMatch(message)
    })
  })

  it("never writes a password or a code into the page text", async () => {
    // inputs hold what the person types; nothing else repeats it
    const port = createFakePort()
    const { container } = renderWizard(port)
    await chooseServer(port)
    click("Создать учётную запись")
    await fillCreateForm()
    expect(container.textContent ?? "").not.toContain(STRONG)
  })
})
