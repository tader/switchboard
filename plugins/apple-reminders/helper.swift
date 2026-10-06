import EventKit
import Foundation

struct Input: Decodable {
    let operation: String
    let id: String?
    let listId: String?
    let title: String?
    let notes: String?
    let dueDate: String?
    let completed: Bool?
    let priority: Int?
}

enum HelperError: Error, CustomStringConvertible {
    case message(String)
    var description: String { if case .message(let value) = self { return value }; return "Unknown error" }
}

let store = EKEventStore()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func output(_ status: Int, _ body: Any) {
    let data = try! JSONSerialization.data(withJSONObject: ["status": status, "body": body])
    FileHandle.standardOutput.write(data)
}

func authorizationStatus() -> String {
    switch EKEventStore.authorizationStatus(for: .reminder) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "unknown"
    }
}

func requestAccess() throws -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var requestError: Error?
    if #available(macOS 14.0, *) {
        store.requestFullAccessToReminders { allowed, error in
            granted = allowed; requestError = error; semaphore.signal()
        }
    } else {
        store.requestAccess(to: .reminder) { allowed, error in
            granted = allowed; requestError = error; semaphore.signal()
        }
    }
    semaphore.wait()
    if let requestError { throw requestError }
    return granted
}

func requireAccess() throws {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    if status == .notDetermined {
        guard try requestAccess() else { throw HelperError.message("Reminders access was not granted") }
        return
    }
    if #available(macOS 14.0, *) {
        guard status == .fullAccess else { throw HelperError.message("Reminders access is \(authorizationStatus()). Grant full access in System Settings → Privacy & Security → Reminders.") }
    } else {
        guard status == .authorized else { throw HelperError.message("Reminders access is \(authorizationStatus()). Grant access in System Settings → Privacy & Security → Reminders.") }
    }
}

func reminderJSON(_ reminder: EKReminder) -> [String: Any] {
    var value: [String: Any] = [
        "id": reminder.calendarItemIdentifier,
        "listId": reminder.calendar.calendarIdentifier,
        "list": reminder.calendar.title,
        "title": reminder.title ?? "",
        "completed": reminder.isCompleted,
        "priority": reminder.priority,
    ]
    if let notes = reminder.notes { value["notes"] = notes }
    if let components = reminder.dueDateComponents, let date = Calendar.current.date(from: components) {
        value["dueDate"] = iso.string(from: date)
    }
    if let date = reminder.completionDate { value["completionDate"] = iso.string(from: date) }
    if let url = reminder.url { value["url"] = url.absoluteString }
    return value
}

func fetch(_ calendars: [EKCalendar]?) throws -> [EKReminder] {
    let semaphore = DispatchSemaphore(value: 0)
    var result: [EKReminder]?
    store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
        result = reminders; semaphore.signal()
    }
    semaphore.wait()
    guard let result else { throw HelperError.message("EventKit did not return reminders") }
    return result
}

func calendar(_ id: String?) throws -> EKCalendar {
    if let id {
        guard let match = store.calendars(for: .reminder).first(where: { $0.calendarIdentifier == id }) else {
            throw HelperError.message("Reminder list not found")
        }
        return match
    }
    guard let value = store.defaultCalendarForNewReminders() else { throw HelperError.message("No default reminder list is configured") }
    return value
}

func reminder(_ id: String?) throws -> EKReminder {
    guard let id, let value = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw HelperError.message("Reminder not found")
    }
    return value
}

func parsedDate(_ value: String) throws -> Date {
    if let date = iso.date(from: value) { return date }
    let fallback = ISO8601DateFormatter()
    if let date = fallback.date(from: value) { return date }
    throw HelperError.message("dueDate must be an ISO 8601 date-time")
}

do {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    let input = try JSONDecoder().decode(Input.self, from: inputData)
    let supplied = try JSONSerialization.jsonObject(with: inputData) as? [String: Any] ?? [:]
    if input.operation == "authorize" {
        try requireAccess()
        output(200, ["authorized": true, "status": authorizationStatus()])
        exit(0)
    }
    try requireAccess()
    switch input.operation {
    case "lists":
        let lists = store.calendars(for: .reminder).map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title] }
        output(200, lists)
    case "list":
        let calendars = input.listId.map { [try calendar($0)] }
        let reminders = try fetch(calendars).map(reminderJSON).sorted { String(describing: $0["title"]) < String(describing: $1["title"]) }
        output(200, reminders)
    case "get":
        output(200, reminderJSON(try reminder(input.id)))
    case "create":
        guard let title = input.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HelperError.message("title is required") }
        let value = EKReminder(eventStore: store)
        value.calendar = try calendar(input.listId)
        value.title = title
        value.notes = input.notes
        if let dueDate = input.dueDate { value.dueDateComponents = Calendar.current.dateComponents(in: .current, from: try parsedDate(dueDate)) }
        if let priority = input.priority { value.priority = priority }
        try store.save(value, commit: true)
        output(201, reminderJSON(value))
    case "update":
        let value = try reminder(input.id)
        if let title = input.title { value.title = title }
        if supplied.keys.contains("notes") { value.notes = input.notes }
        if let listId = input.listId { value.calendar = try calendar(listId) }
        if supplied.keys.contains("dueDate") {
            value.dueDateComponents = try input.dueDate.map { Calendar.current.dateComponents(in: .current, from: try parsedDate($0)) }
        }
        if let completed = input.completed { value.isCompleted = completed }
        if let priority = input.priority { value.priority = priority }
        try store.save(value, commit: true)
        output(200, reminderJSON(value))
    case "delete":
        try store.remove(try reminder(input.id), commit: true)
        output(200, ["deleted": true])
    default:
        output(400, ["error": "Unknown operation"])
    }
} catch {
    output(400, ["error": String(describing: error)])
}
