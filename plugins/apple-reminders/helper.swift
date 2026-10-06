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
    let hideCompleted: Bool?
    let due: String?
    let dueDateLt: String?
    let dueDateLte: String?
    let dueDateGt: String?
    let dueDateGte: String?
    let completionDateLt: String?
    let completionDateLte: String?
    let completionDateGt: String?
    let completionDateGte: String?
    let offset: Int?
    let limit: Int?
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

func optionalDate(_ value: String?) throws -> Date? {
    guard let value else { return nil }
    return try parsedDate(value)
}

func page(_ values: [[String: Any]], offset: Int?, limit: Int?) -> [String: Any] {
    let start = max(0, min(offset ?? 0, values.count))
    let size = max(1, min(limit ?? 100, 100))
    let end = min(start + size, values.count)
    var result: [String: Any] = ["items": Array(values[start..<end])]
    if end < values.count { result["nextOffset"] = end }
    return result
}

func reminderDate(_ reminder: EKReminder) -> Date? {
    guard let components = reminder.dueDateComponents else { return nil }
    return Calendar.current.date(from: components)
}

func datesMatch(_ value: Date?, lt: Date?, lte: Date?, gt: Date?, gte: Date?) -> Bool {
    guard let value else { return lt == nil && lte == nil && gt == nil && gte == nil }
    if let lt, !(value < lt) { return false }
    if let lte, !(value <= lte) { return false }
    if let gt, !(value > gt) { return false }
    if let gte, !(value >= gte) { return false }
    return true
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
        let lists: [[String: Any]] = store.calendars(for: .reminder)
            .map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title] as [String: Any] }
            .sorted { String(describing: $0["title"]) < String(describing: $1["title"]) }
        output(200, page(lists, offset: input.offset, limit: input.limit))
    case "list":
        let calendars: [EKCalendar]?
        if let listId = input.listId {
            calendars = [try calendar(listId)]
        } else {
            calendars = nil
        }
        let dueLt = try optionalDate(input.dueDateLt)
        let dueLte = try optionalDate(input.dueDateLte)
        let dueGt = try optionalDate(input.dueDateGt)
        let dueGte = try optionalDate(input.dueDateGte)
        let completionLt = try optionalDate(input.completionDateLt)
        let completionLte = try optionalDate(input.completionDateLte)
        let completionGt = try optionalDate(input.completionDateGt)
        let completionGte = try optionalDate(input.completionDateGte)
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        let dayAfterTomorrow = calendar.date(byAdding: .day, value: 2, to: today)!
        let weekEnd = calendar.date(byAdding: .day, value: 7, to: today)!
        let reminders = try fetch(calendars).filter { reminder in
            if input.hideCompleted == true && reminder.isCompleted { return false }
            let dueDate = reminderDate(reminder)
            switch input.due {
            case "overdue": if reminder.isCompleted || dueDate == nil || dueDate! >= today { return false }
            case "today": if dueDate == nil || dueDate! < today || dueDate! >= tomorrow { return false }
            case "tomorrow": if dueDate == nil || dueDate! < tomorrow || dueDate! >= dayAfterTomorrow { return false }
            case "next7Days": if dueDate == nil || dueDate! < today || dueDate! >= weekEnd { return false }
            case nil: break
            default: return false
            }
            return datesMatch(dueDate, lt: dueLt, lte: dueLte, gt: dueGt, gte: dueGte)
                && datesMatch(reminder.completionDate, lt: completionLt, lte: completionLte, gt: completionGt, gte: completionGte)
        }.sorted { left, right in
            let leftDate = reminderDate(left)
            let rightDate = reminderDate(right)
            if leftDate != rightDate { return leftDate == nil ? false : rightDate == nil ? true : leftDate! < rightDate! }
            if left.title != right.title { return (left.title ?? "").localizedCaseInsensitiveCompare(right.title ?? "") == .orderedAscending }
            return left.calendarItemIdentifier < right.calendarItemIdentifier
        }.map(reminderJSON)
        output(200, page(reminders, offset: input.offset, limit: input.limit))
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
            if let dueDate = input.dueDate {
                value.dueDateComponents = Calendar.current.dateComponents(in: .current, from: try parsedDate(dueDate))
            } else {
                value.dueDateComponents = nil
            }
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
